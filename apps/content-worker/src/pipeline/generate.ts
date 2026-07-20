import { eq, schema } from '@bmas/db';
import type { ContentGenerationJob, CreativeRequest } from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import { composeBrief, generateCopy, generateImages, qaImages } from './stages.js';

/**
 * Orchestrates the creative pipeline for one job. The `stage` column is updated
 * as it advances so the UI can show which step is running rather than a bare
 * spinner (NFR: "UI communicates progress per pipeline stage").
 */
export async function runGeneration(ctx: WorkerContext, job: ContentGenerationJob): Promise<void> {
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

  const stageCtx = { ai: ctx.ai, brand, request: row.request as unknown as CreativeRequest };

  const setStage = async (stage: string) => {
    await ctx.db
      .update(schema.generationJobs)
      .set({ stage, status: 'running', startedAt: row.startedAt ?? new Date() })
      .where(eq(schema.generationJobs.id, job.jobId));
  };

  try {
    await setStage('brief');
    const brief = await composeBrief(stageCtx);

    await setStage('image');
    const images = await generateImages(stageCtx, brief);

    await setStage('qa');
    const checked = await qaImages(stageCtx, images);

    await setStage('copy');
    const copy = await generateCopy(stageCtx);

    // TODO(content): persist creative_assets from `checked` and copy_packs from
    // `copy`, then debit the credit ledger for the accepted generation.
    void checked;
    void copy;

    await ctx.db
      .update(schema.generationJobs)
      .set({ status: 'succeeded', stage: null, finishedAt: new Date() })
      .where(eq(schema.generationJobs.id, job.jobId));
  } catch (error) {
    await ctx.db
      .update(schema.generationJobs)
      .set({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      })
      .where(eq(schema.generationJobs.id, job.jobId));
    throw error;
  }
}
