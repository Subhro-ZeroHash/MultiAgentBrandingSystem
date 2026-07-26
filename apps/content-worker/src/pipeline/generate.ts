import { describeError } from '@bmas/ai';
import { eq, schema } from '@bmas/db';
import type { ContentGenerationJob, CreativeRequest } from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import {
  composeBrief,
  generateCopy,
  generateImages,
  qaImages,
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
      .set({ stage, status: 'running', startedAt: row.startedAt ?? new Date() })
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
    const checked = await qaImages(stageCtx, images, brief);

    // One transaction: a job that reports `succeeded` must never be missing
    // half its output. Partial rows would surface in the UI as a generation
    // with images but no caption, which reads as a bug rather than a failure.
    await ctx.db.transaction(async (tx) => {
      if (checked.length) {
        await tx.insert(schema.creativeAssets).values(
          checked.map((variant) => ({
            jobId: job.jobId,
            storageKey: variant.storageKey,
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
  } catch (error) {
    const isFinalAttempt = attemptInfo.attempt >= attemptInfo.maxAttempts;
    const message = describeError(error);

    console.error(
      `[content:generation] job ${job.jobId}: attempt ${attemptInfo.attempt}/${attemptInfo.maxAttempts} failed — ${message}`,
      error,
    );

    await ctx.db
      .update(schema.generationJobs)
      .set(
        isFinalAttempt
          ? { status: 'failed', error: message, finishedAt: new Date() }
          : // Still retrying: keep the row `running` so the client keeps
            // polling, but record why in case this turns out to be the last
            // word. `finishedAt` stays null — the job is not finished.
            { status: 'running', error: `${message} (retrying)` },
      )
      .where(eq(schema.generationJobs.id, job.jobId));

    throw error;
  }
}
