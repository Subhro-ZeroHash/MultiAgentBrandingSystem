import { withRetry, withTimeout } from '@bmas/ai';
import { eq, schema } from '@bmas/db';
import type { ContentEditJob, CostEvent } from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import { mediaTypeFor, writeThumbnail } from './stages.js';

/**
 * User-initiated "Regenerate" on one creative asset (FR-3.3) — a targeted
 * edit, not a rerun of the brief/image/QA pipeline in generate.ts. Reuses the
 * `ImageGenService.edit()` capability and `creativeAssets.edits` column that
 * already existed for exactly this, unwired until now.
 *
 * A single, fairly quick provider call, so this gets its own small pipeline
 * rather than routing through StageContext/generate.ts's multi-stage
 * machinery — there is no brief to compose and nothing to QA (see
 * `generations.service.ts::regenerateAsset` for why QA is skipped).
 */

/** An edit is one image, one call — generous but well under the full
 *  multi-variant generate budget (`IMAGE_TIMEOUT_MS` in stages.ts). */
const EDIT_TIMEOUT_MS = 120_000;

async function recordCost(
  ctx: WorkerContext,
  brandId: string,
  jobId: string,
  cost: CostEvent,
): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId,
    system: 'content',
    referenceId: jobId,
    provider: cost.provider,
    model: cost.model,
    operation: cost.operation,
    inputTokens: cost.inputTokens ?? null,
    outputTokens: cost.outputTokens ?? null,
    cachedInputTokens: cost.cachedInputTokens ?? null,
    imageCount: cost.imageCount ?? null,
    costMicroUsd: cost.costMicroUsd,
    latencyMs: cost.latencyMs ?? null,
  });
}

export async function runAssetEdit(ctx: WorkerContext, job: ContentEditJob): Promise<void> {
  const [edit] = await ctx.db
    .select()
    .from(schema.assetEdits)
    .where(eq(schema.assetEdits.id, job.editId))
    .limit(1);
  if (!edit) throw new Error(`Asset edit ${job.editId} not found`);

  // The queue is configured with attempts:1 (a capped, user-facing budget —
  // see generations.service.ts — must never be silently spent by an
  // automatic retry), so this should never legitimately re-run. Guards
  // against BullMQ redelivery after a crash between claim and this check
  // anyway, the same way trend-research/generate guard their own status
  // columns.
  if (edit.status !== 'queued') {
    console.warn(
      `[asset-edit] edit ${edit.id} is already '${edit.status}', skipping duplicate delivery`,
    );
    return;
  }

  await ctx.db
    .update(schema.assetEdits)
    .set({ status: 'running' })
    .where(eq(schema.assetEdits.id, edit.id));

  try {
    const [source] = await ctx.db
      .select()
      .from(schema.creativeAssets)
      .where(eq(schema.creativeAssets.id, edit.sourceAssetId))
      .limit(1);
    if (!source) throw new Error(`Source asset ${edit.sourceAssetId} not found`);

    const [genJob] = await ctx.db
      .select({ brandId: schema.generationJobs.brandId })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.id, source.jobId))
      .limit(1);
    if (!genJob) throw new Error(`Generation job ${source.jobId} not found`);

    const image = await ctx.storage.get(source.storageKey);
    // Every creative asset is written as png or jpeg (see `renderVariants` in
    // stages.ts, which never emits webp) — webp is only ever a *product
    // photo* upload format. `ImageEditRequest` doesn't accept it, and a
    // creative asset never needs it to.
    const mediaType = mediaTypeFor(source.storageKey);
    if (mediaType === 'image/webp') {
      throw new Error(`Unexpected webp creative asset ${source.id} — cannot edit it`);
    }

    const { value: result, cost } = await withRetry(() =>
      withTimeout(
        ctx.ai
          .imageGenerator()
          .edit(
            { image, mediaType, instruction: edit.instruction },
            { referenceId: source.jobId, brandId: genJob.brandId },
          ),
        EDIT_TIMEOUT_MS,
        'image:edit',
      ),
    );

    await recordCost(ctx, genJob.brandId, source.jobId, cost);

    // Keyed off the edit's own id rather than forced into the
    // `variant-N[-rN]` scheme `creativeKey` builds for the original fan-out —
    // that scheme numbers by array position within one generate() call, which
    // an edit doesn't have, and the edit id is already a globally unique,
    // sufficient key on its own.
    const ext = result.mediaType === 'image/jpeg' ? 'jpg' : 'png';
    const storageKey = `brands/${genJob.brandId}/generations/${source.jobId}/edit-${edit.id}.${ext}`;
    await ctx.storage.put(storageKey, result.data, result.mediaType);
    const thumbnailStorageKey = await writeThumbnail(
      { storage: ctx.storage, jobId: source.jobId },
      storageKey,
      result.data,
    );

    const [inserted] = await ctx.db
      .insert(schema.creativeAssets)
      .values({
        jobId: source.jobId,
        storageKey,
        thumbnailStorageKey,
        width: result.width,
        height: result.height,
        provider: ctx.ai.imageGenerator().provider,
        model: result.model,
        variantKind: source.variantKind,
        // Always points at the slot's original asset, not the immediately
        // prior edit — see `creativeAssets.rootAssetId` in the schema.
        rootAssetId: source.rootAssetId ?? source.id,
        edits: [...source.edits, { instruction: edit.instruction, at: new Date().toISOString() }],
      })
      .returning();
    if (!inserted) throw new Error('Insert returned no row');

    await ctx.db
      .update(schema.assetEdits)
      .set({ status: 'succeeded', resultAssetId: inserted.id, finishedAt: new Date() })
      .where(eq(schema.assetEdits.id, edit.id));
  } catch (error) {
    // Deliberately swallowed, not rethrown: attempts:1 means BullMQ will not
    // retry anyway, and the row itself is how the client learns the outcome
    // (polled via GET /generations/:jobId) — there is nothing upstream of
    // this call that needs the exception.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[asset-edit] edit ${edit.id} failed: ${message}`, error);
    await ctx.db
      .update(schema.assetEdits)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(schema.assetEdits.id, edit.id));
  }
}
