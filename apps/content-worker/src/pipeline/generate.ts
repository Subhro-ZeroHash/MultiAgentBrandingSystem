import { describeError, isPermanentFailure } from '@bmas/ai';
import { and, desc, eq, ne, schema, sql } from '@bmas/db';
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
  type TrendContext,
  type VariantKind,
} from './stages.js';

/** The three knowledge sources a diverse-mode generation fans out across. */
const DIVERSE_VARIANT_KINDS: readonly VariantKind[] = ['trend', 'website', 'clean'];

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
 * The brand's website-derived identity, if there is one to use (FR-1.4).
 *
 * Gated on `appliedAt`: an import the user never confirmed, or confirmed only
 * for the Brand Kit fields, must not reach generation. Reading the column here
 * rather than in the stages means one query per job instead of two, and one
 * place where that rule lives.
 *
 * A failure is swallowed deliberately. This is enrichment — a brand with no
 * site profile generates perfectly well without one — so a bad row should cost
 * some polish, never a paid job that was otherwise fine.
 */
async function loadSiteIdentity(
  ctx: WorkerContext,
  brandId: string,
): Promise<Pick<StageContext, 'siteIdentity' | 'logoStorageKey' | 'styleReferenceKeys'>> {
  const none = { siteIdentity: null, logoStorageKey: null, styleReferenceKeys: [] };

  try {
    const [row] = await ctx.db
      .select({
        analysis: schema.brandSiteProfiles.analysis,
        appliedAt: schema.brandSiteProfiles.appliedAt,
        logoStorageKey: schema.brandSiteProfiles.logoStorageKey,
        logoAppliedAt: schema.brandSiteProfiles.logoAppliedAt,
        styleReferenceKeys: schema.brandSiteProfiles.styleReferenceKeys,
        styleReferencesAppliedAt: schema.brandSiteProfiles.styleReferencesAppliedAt,
      })
      .from(schema.brandSiteProfiles)
      .where(eq(schema.brandSiteProfiles.brandId, brandId))
      .limit(1);

    if (!row) return none;

    // Each opt-in is read independently: a user may want the art direction but
    // not the logo, and resolving them together would couple two choices the
    // apply endpoint deliberately keeps apart.
    return {
      siteIdentity: row.appliedAt ? (row.analysis ?? null) : null,
      logoStorageKey: row.logoAppliedAt ? row.logoStorageKey : null,
      styleReferenceKeys: row.styleReferencesAppliedAt ? (row.styleReferenceKeys ?? []) : [],
    };
  } catch (error) {
    console.error(`[generate] could not load the site profile for brand ${brandId}:`, error);
    return none;
  }
}

/**
 * The brand's most recent Trend Research result, if any — the 'trend'
 * variant's counterpart to `loadSiteIdentity` above, same shape: one best-
 * effort read, swallowed on failure, because a brand that never ran (or
 * whose last run found nothing) still generates fine without one.
 *
 * Automatic rather than a picked idea: the user asked for "the news and
 * trends we get by tavily" to shape one image, not a new required step in
 * the create flow, so this takes whatever the brand's last successful run
 * already surfaced. Same "sort ideas by score.overall in memory" idiom as
 * `trends.service.ts::getRun` — a run has at most 8 ideas, not worth a
 * database-side jsonb sort.
 */
async function loadTrendContext(
  ctx: WorkerContext,
  brandId: string,
): Promise<TrendContext | null> {
  try {
    const [run] = await ctx.db
      .select({ id: schema.trendResearchRuns.id })
      .from(schema.trendResearchRuns)
      .where(
        and(
          eq(schema.trendResearchRuns.brandId, brandId),
          eq(schema.trendResearchRuns.status, 'succeeded'),
        ),
      )
      .orderBy(desc(schema.trendResearchRuns.createdAt))
      .limit(1);
    if (!run) return null;

    const ideas = await ctx.db
      .select({
        title: schema.trendIdeas.title,
        summary: schema.trendIdeas.summary,
        recommendation: schema.trendIdeas.recommendation,
        score: schema.trendIdeas.score,
      })
      .from(schema.trendIdeas)
      .where(eq(schema.trendIdeas.runId, run.id));
    if (ideas.length === 0) return null;

    const top = [...ideas].sort((a, b) => b.score.overall - a.score.overall)[0]!;
    return { title: top.title, summary: top.summary, recommendation: top.recommendation };
  } catch (error) {
    console.error(`[generate] could not load trend context for brand ${brandId}:`, error);
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

  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, job.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${job.brandId} not found`);

  const request = row.request as unknown as CreativeRequest;
  const diverse = request.variantMode === 'diverse';

  const stageCtx: StageContext = {
    ai: ctx.ai,
    brand,
    request,
    db: ctx.db,
    storage: ctx.storage,
    jobId: job.jobId,
    ...(await loadSiteIdentity(ctx, job.brandId)),
    // Only fetched in diverse mode — a uniform-mode job (every scheduled
    // campaign) never reads it, so there is no reason to spend the query.
    trendContext: diverse ? await loadTrendContext(ctx, job.brandId) : null,
  };

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
        and(
          eq(schema.generationJobs.id, job.jobId),
          ne(schema.generationJobs.status, 'cancelled'),
        ),
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
