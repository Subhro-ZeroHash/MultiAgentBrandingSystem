import { eq, schema } from '@bmas/db';
import type { AnswerEngine, GeoProbeJob } from '@bmas/shared';
import type { WorkerContext } from '../context.js';
import { analyzeAnswer } from './analyze.js';

/**
 * One (prompt, engine) probe end to end: ask the engine, store the raw answer,
 * extract mentions, record cost. The raw answer is persisted before analysis so
 * a failure in the analyser never costs us the paid-for probe.
 */
export async function runProbe(ctx: WorkerContext, job: GeoProbeJob): Promise<void> {
  const client = ctx.ai.answerEngine(job.engine as AnswerEngine);
  if (!client || !client.isConfigured()) {
    // Not an error: engines without credentials are simply out of scope for now.
    return;
  }

  const [prompt] = await ctx.db
    .select()
    .from(schema.trackedPrompts)
    .where(eq(schema.trackedPrompts.id, job.promptId))
    .limit(1);
  if (!prompt) throw new Error(`Tracked prompt ${job.promptId} not found`);

  const [brand] = await ctx.db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, job.brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${job.brandId} not found`);

  const competitors = await ctx.db
    .select()
    .from(schema.competitors)
    .where(eq(schema.competitors.brandId, job.brandId));

  const answer = await client.ask({ prompt: prompt.text, locale: prompt.locale });

  const [run] = await ctx.db
    .insert(schema.probeRuns)
    .values({
      promptId: prompt.id,
      brandId: brand.id,
      engine: answer.value.engine,
      model: answer.value.model,
      answerText: answer.value.text,
      citations: answer.value.citations,
      latencyMs: answer.value.latencyMs,
    })
    .returning();
  if (!run) throw new Error('Failed to persist probe run');

  await recordCost(ctx, {
    brandId: brand.id,
    referenceId: run.id,
    cost: answer.cost,
  });

  const { analysis, cost: analysisCost } = await analyzeAnswer(ctx.ai, {
    answerText: answer.value.text,
    citations: answer.value.citations,
    brandName: brand.name,
    brandAliases: [],
    competitors: competitors.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
  });

  if (analysis.mentions.length > 0) {
    // The analysis prompt offers aliases as valid ways to name a competitor
    // (see analyze.ts), so the lookup has to accept them too — indexing only
    // `name` sent every alias-named mention to entityId 'unknown'.
    const byName = new Map<string, string>();
    for (const competitor of competitors) {
      byName.set(competitor.name.toLowerCase(), competitor.id);
      for (const alias of competitor.aliases) {
        byName.set(alias.toLowerCase(), competitor.id);
      }
    }

    await ctx.db.insert(schema.mentions).values(
      analysis.mentions.map((mention) => ({
        probeRunId: run.id,
        brandId: brand.id,
        entityType: mention.entityType,
        entityId:
          mention.entityType === 'brand'
            ? brand.id
            : (byName.get(mention.entityName.toLowerCase()) ?? 'unknown'),
        entityName: mention.entityName,
        position: mention.position,
        sentiment: mention.sentiment,
        excerpt: mention.excerpt,
        citedUrl: mention.citedUrl,
      })),
    );
  }

  // Real provider/model/tokens from the call that was actually made — not
  // hardcoded, since LLM_PROVIDER can be anthropic or gemini. `operation` is
  // overridden to a stage-specific label so this is distinguishable in the
  // ledger from other orchestrator-role JSON calls.
  await recordCost(ctx, {
    brandId: brand.id,
    referenceId: run.id,
    cost: { ...analysisCost, operation: 'geo:analyze' },
  });
}

async function recordCost(
  ctx: WorkerContext,
  args: {
    brandId: string;
    referenceId: string;
    cost: { provider: string; model: string; operation: string; costMicroUsd: number } & Record<
      string,
      unknown
    >;
  },
): Promise<void> {
  await ctx.db.insert(schema.costEvents).values({
    brandId: args.brandId,
    system: 'geo',
    referenceId: args.referenceId,
    provider: args.cost.provider,
    model: args.cost.model,
    operation: args.cost.operation,
    inputTokens: (args.cost.inputTokens as number | undefined) ?? null,
    outputTokens: (args.cost.outputTokens as number | undefined) ?? null,
    latencyMs: (args.cost.latencyMs as number | undefined) ?? null,
    costMicroUsd: args.cost.costMicroUsd,
  });
}
