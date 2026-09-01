import { describeError, isPermanentFailure } from '@bmas/ai';
import {
  and,
  eq,
  getContentContext,
  ne,
  recordContextSnapshot,
  schema,
  sql,
  type ContentTaskContext,
} from '@bmas/db';
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
  type CheckedVariant,
  type StageContext,
  type VariantKind,
} from './stages.js';

/**
 * The knowledge sources a diverse-mode generation fans out across — one image
 * per entry, so this list's length is the actual per-job image count
 * regardless of `request.variantCount` (diverse mode never reads that field).
 *
 * Trimmed from three to two ('trend', 'website', 'clean') to cut image-gen
 * spend by a third while there is no working provider key. 'clean' (no extra
 * source beyond the brief) was dropped as the least differentiated of the
 * three — 'website' still grounds a variant in the brand's own site, 'trend'
 * still keeps one timely. Restore 'clean' here once a provider key is live
 * and cost is no longer the binding constraint.
 */
const DIVERSE_VARIANT_KINDS: readonly VariantKind[] = ['trend', 'website'];

/**
 * The user cancelled while this job was mid-pipeline.
 *
 * Not a failure: the row is already `cancelled` and that is the state the user
 * asked for, so the catch below must not overwrite it with `failed` or spend a
 * retry re-running work nobody wants.
 */
class GenerationCancelledError extends Error {
  constructor(jobId: string) {
    super(`Generation ${jobId} was cancelled`);
    this.name = 'GenerationCancelledError';
  }
}

/** Where this run sits in BullMQ's retry sequence, both 1-based. */
export interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
}

/**
 * Brand Memory for this generation, assembled by the Context Manager.
 *
 * Replaces the two hand-rolled loaders that used to live here
 * (`loadSiteIdentity` and `loadTrendContext`). They resolved the website
 * opt-ins and the latest trend idea correctly, but they were the *only* brand
 * data generation ever saw — the goals, positioning, content pillars and
 * learned preferences the platform had been accumulating reached no prompt at
 * all. Same reads, one place, plus everything that was being written and never
 * read.
 *
 * A failure is swallowed deliberately, as before: this is enrichment, and a
 * brand with no context generates perfectly well without it. A bad row should
 * cost some polish, never a paid job that was otherwise fine.
 */
async function loadBrandMemory(
  ctx: WorkerContext,
  brandId: string,
  includeTrend: boolean,
): Promise<ContentTaskContext | null> {
  try {
    return await getContentContext(ctx.db, brandId, { includeTrend });
  } catch (error) {
    console.error(`[generate] could not load brand context for brand ${brandId}:`, error);
    return null;
  }
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

  // brandId comes off the row this job's own id points to, not the queue
  // payload — a job producer bug or lesser Redis-level compromise could
  // otherwise enqueue {jobId, brandId} with a mismatched pair and have this
  // worker attribute one brand's generation to another's context.
  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, row.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${row.brandId} not found`);

  const request = row.request as unknown as CreativeRequest;
  const diverse = request.variantMode === 'diverse';

  // The trend read is only worth paying for in diverse mode — a uniform-mode
  // job (every scheduled campaign) never reaches the 'trend' variant.
  const memory = await loadBrandMemory(ctx, row.brandId, diverse);

  const stageCtx: StageContext = {
    ai: ctx.ai,
    brand,
    request,
    db: ctx.db,
    storage: ctx.storage,
    jobId: job.jobId,
    siteIdentity: memory?.siteIdentity ?? null,
    logoStorageKey: memory?.logoStorageKey ?? null,
    styleReferenceKeys: memory?.styleReferenceKeys ?? [],
    trendContext: memory?.currentTrend
      ? {
          title: memory.currentTrend.title,
          summary: memory.currentTrend.summary,
          recommendation: memory.currentTrend.recommendation,
        }
      : null,
    brandMemory: memory,
  };

  // Correlated to the job, so "why did this creative come out like that?" is
  // answerable from the row rather than reconstructed from today's context.
  if (memory) {
    await recordContextSnapshot(ctx.db, {
      brandId: row.brandId,
      agentType: 'content',
      snapshot: { ...memory, variantMode: request.variantMode ?? 'uniform' },
      usedInJobId: job.jobId,
    });
  }

  /**
   * Advances the stage, and doubles as the cancellation checkpoint.
   *
   * The `ne(cancelled)` makes this a claim rather than a blind write: if the
   * user cancelled while the previous stage was running, no row comes back and
   * the pipeline stops before paying for the next one. Stage boundaries are the
   * right granularity — a provider call already in flight cannot be recalled,
   * but the three still ahead of it can be.
   */
  const setStage = async (stage: string) => {
    const [row] = await ctx.db
      .update(schema.generationJobs)
      .set({
        stage,
        status: 'running',
        startedAt: sql`coalesce(${schema.generationJobs.startedAt}, now())`,
      })
      .where(
        and(eq(schema.generationJobs.id, job.jobId), ne(schema.generationJobs.status, 'cancelled')),
      )
      .returning();

    if (!row) throw new GenerationCancelledError(job.jobId);
  };

  try {
    // Copy runs first because the headline and CTA it writes are rendered onto
    // the creative itself — the brief cannot be composed until they exist.
    // It depends on nothing the later stages produce, so the move is safe.
    await setStage('copy');
    const copy = await generateCopy(stageCtx);

    await setStage('brief');
    await setStage('image');
    await setStage('qa');

    // Diverse mode: three independent brief→image→QA→retry mini-pipelines,
    // one per knowledge source, run in parallel and merged. Each reuses
    // qaImages/regenerateFailures completely unchanged — they already operate
    // on an arbitrary-length variant array, and a length-1 array (one kind's
    // own single image) is just the degenerate case. Uniform mode (every
    // scheduled-campaign generation) is untouched: one brief, one call.
    const checked: CheckedVariant[] = diverse
      ? (
          await Promise.all(
            DIVERSE_VARIANT_KINDS.map(async (kind) => {
              const kindBrief = await composeBrief(stageCtx, copy[0], kind);
              const kindImages = await generateImages(stageCtx, kindBrief, kind);
              const kindReadback = await qaImages(stageCtx, kindImages, kindBrief);
              const kindChecked = await regenerateFailures(
                stageCtx,
                kindBrief,
                kindReadback,
                ctx.qaRegenerationRounds,
                kind,
              );
              return kindChecked.map((variant) => ({ ...variant, variantKind: kind }));
            }),
          )
        ).flat()
      : await (async () => {
          const brief = await composeBrief(stageCtx, copy[0]);
          const images = await generateImages(stageCtx, brief);
          const readback = await qaImages(stageCtx, images, brief);
          // FR-3.5: a failed readback earns one bounded retry rather than
          // shipping a variant with misspelled text on it. The ceiling is
          // configuration.
          return regenerateFailures(stageCtx, brief, readback, ctx.qaRegenerationRounds);
        })();

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
            variantKind: variant.variantKind ?? null,
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
    //
    // Isolated in its own try/catch rather than left to the one below: the job
    // row was already committed 'succeeded' above, with real assets/copy
    // inserted and providers already paid for. If this hook throws (e.g. a
    // transient DB blip), the outer catch cannot tell that apart from a real
    // pipeline failure — it would flip the row back to 'running'/'failed' and,
    // on a non-final attempt, let BullMQ retry the whole job, re-running the
    // pipeline from scratch and inserting a second set of asset/copy rows
    // while double-billing every provider call. A hook failure is treated as
    // best-effort instead, the same way `sendExpoPush` inside it already is.
    try {
      await onGenerationSucceeded(ctx.db, job.jobId);
    } catch (hookError) {
      console.error(
        `[content:generation] job ${job.jobId}: succeeded, but the post-success hook failed — ${describeError(hookError)}`,
        hookError,
      );
    }
  } catch (error) {
    // Cancellation is an outcome, not a fault. The row already says
    // `cancelled`; writing `failed` over it would contradict what the user was
    // told, and retrying would re-run work they explicitly stopped.
    if (error instanceof GenerationCancelledError) {
      console.warn(`[content:generation] job ${job.jobId}: cancelled by the user, stopping`);
      await ctx.db
        .update(schema.generationJobs)
        .set({ stage: null, finishedAt: new Date() })
        .where(eq(schema.generationJobs.id, job.jobId));
      return;
    }

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
