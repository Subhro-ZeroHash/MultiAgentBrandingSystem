import { describeError, isPermanentFailure } from '@bmas/ai';
import { eq, schema, sql } from '@bmas/db';
import { UnrecoverableError } from 'bullmq';
import type { ContentGenerationJob, CreativeRequest } from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import { onGenerationFailed, onGenerationSucceeded } from './scheduled-post-hooks.js';
import {
  composeBrief,
  generateCopy,
  generateImages,
  qaImages,
  regenerateFailures,
  type StageContext,
} from './stages.js';

/** Where this run sits in BullMQ's retry sequence, both 1-based. */
export interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
}

/**
 * Orchestrates the creative pipeline for one job. The `stage` column is updated
 * as it advances so the UI can show which step is running rather than a bare
 * spinner (NFR: "UI communicates progress per pipeline stage").
 *
 * `attemptInfo` exists because the job row is what the client polls, and BullMQ
 * retries underneath it. Writing `failed` on a non-final attempt shows the user
 * a failure dialog for a job that is still running and will usually succeed on
 * the next try — so the row stays `running` until the retries are spent.
 */
export async function runGeneration(
  ctx: WorkerContext,
  job: ContentGenerationJob,
  attemptInfo: AttemptInfo = { attempt: 1, maxAttempts: 1 },
): Promise<void> {
  const [row] = await ctx.db
    .select()
    .from(schema.generationJobs)
    .where(eq(schema.generationJobs.id, job.jobId))
    .limit(1);
  if (!row) throw new Error(`Generation job ${job.jobId} not found`);

  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, job.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${job.brandId} not found`);

  const stageCtx: StageContext = {
    ai: ctx.ai,
    brand,
    request: row.request as unknown as CreativeRequest,
    db: ctx.db,
    storage: ctx.storage,
    jobId: job.jobId,
  };

  const setStage = async (stage: string) => {
    await ctx.db
      .update(schema.generationJobs)
      .set({
        stage,
        status: 'running',
        startedAt: sql`coalesce(${schema.generationJobs.startedAt}, now())`,
      })
      .where(eq(schema.generationJobs.id, job.jobId));
  };

  try {
    // Copy runs first because the headline and CTA it writes are rendered onto
    // the creative itself — the brief cannot be composed until they exist.
    // It depends on nothing the later stages produce, so the move is safe.
    await setStage('copy');
    const copy = await generateCopy(stageCtx);

    await setStage('brief');
    const brief = await composeBrief(stageCtx, copy[0]);

    await setStage('image');
    const images = await generateImages(stageCtx, brief);

    await setStage('qa');
    const readback = await qaImages(stageCtx, images, brief);
    // FR-3.5: a failed readback earns one bounded retry rather than shipping a
    // variant with misspelled text on it. The ceiling is configuration.
    const checked = await regenerateFailures(stageCtx, brief, readback, ctx.qaRegenerationRounds);

    // One transaction: a job that reports `succeeded` must never be missing
    // half its output. Partial rows would surface in the UI as a generation
    // with images but no caption, which reads as a bug rather than a failure.
    await ctx.db.transaction(async (tx) => {
      if (checked.length) {
        await tx.insert(schema.creativeAssets).values(
          checked.map((variant) => ({
            jobId: job.jobId,
            storageKey: variant.storageKey,
            thumbnailStorageKey: variant.thumbnailStorageKey,
            width: variant.width,
            height: variant.height,
            provider: variant.provider,
            model: variant.model,
            qaResult: {
              passed: variant.passed,
              checked: variant.checked,
              detectedText: variant.detectedText,
              ...(variant.notes ? { notes: variant.notes } : {}),
            },
          })),
        );
      }

      if (copy.length) {
        await tx.insert(schema.copyPacks).values(
          copy.map((pack) => ({
            jobId: job.jobId,
            platform: pack.platform,
            language: pack.language,
            headline: pack.headline,
            caption: pack.caption,
            hashtags: pack.hashtags,
            cta: pack.cta,
          })),
        );
      }
    });

    // TODO(content): debit the credit ledger for the accepted generation. Needs
    // the owning user, which arrives with auth — content.credit_ledger.user_id
    // references core.users, and DEV_OWNER_ID is not a real identity to bill.

    await ctx.db
      .update(schema.generationJobs)
      .set({
        status: 'succeeded',
        stage: null,
        // Cleared explicitly: an earlier attempt may have written one, and a
        // succeeded job carrying an error message reads as a bug in the UI.
        error: null,
        finishedAt: new Date(),
      })
      .where(eq(schema.generationJobs.id, job.jobId));

    // No-op for an ordinary one-shot generation; only fires for jobs a
    // scheduled campaign created, moving that post to 'pending_approval' and
    // notifying the user it's ready to review.
    await onGenerationSucceeded(ctx.db, job.jobId);
  } catch (error) {
    // A failure that cannot succeed on a retry ends the job here, whatever
    // attempts remain. Without this a quota-exhausted key re-ran the whole
    // pipeline three times over ~30s of backoff, paying for every image the
    // earlier stages regenerated before hitting the same wall.
    const permanent = isPermanentFailure(error);
    const isFinalAttempt = attemptInfo.attempt >= attemptInfo.maxAttempts;
    const terminal = permanent || isFinalAttempt;
    const message = describeError(error);

    console.error(
      `[content:generation] job ${job.jobId}: attempt ${attemptInfo.attempt}/${attemptInfo.maxAttempts} failed${
        permanent ? ' — not retryable, giving up' : ''
      } — ${message}`,
      error,
    );

    await ctx.db
      .update(schema.generationJobs)
      .set(
        terminal
          ? { status: 'failed', error: message, finishedAt: new Date() }
          : // Still retrying: keep the row `running` so the client keeps
            // polling, but record why in case this turns out to be the last
            // word. `finishedAt` stays null — the job is not finished.
            { status: 'running', error: `${message} (retrying)` },
      )
      .where(eq(schema.generationJobs.id, job.jobId));

    // Only on the word that's actually final — a job still mid-retry may yet
    // succeed, and marking its scheduled post 'failed' early would surface a
    // false alarm the next attempt then silently contradicts.
    if (terminal) {
      await onGenerationFailed(ctx.db, job.jobId, message);
    }

    if (permanent) {
      // The one signal BullMQ honours to skip the remaining attempts. Its
      // constructor takes only a message, so the cause is attached afterwards
      // — the chain is what `describeError` needs to stay useful in the logs.
      const stop = new UnrecoverableError(message);
      stop.cause = error;
      throw stop;
    }

    throw error;
  }
}
