import { and, desc, eq, gte, isNull, schema, type ProbeRunRow } from '@bmas/db';
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

  // Resume rather than restart. BullMQ retries the whole job on any failure, and
  // analysis fails far more readily than the probe does (bad key, rate limit,
  // malformed JSON). Without this guard a single analyser failure re-ran the
  // engine call on every attempt: three paid probes and three duplicate runs for
  // one prompt, silently inflating runsProbed and every metric derived from it.
  const existing = await findRunInBucket(ctx, prompt.id, job.engine as AnswerEngine);
  const run = existing ?? (await probeAndPersist(ctx, { client, prompt, brand, engine: job.engine }));

  const { analysis, cost: analysisCost } = await analyzeAnswer(ctx.ai, {
    answerText: run.answerText,
    citations: run.citations,
    brandName: brand.name,
    // TODO(geo): core.brands has no aliases column, so a brand named by a
    // variant ("Ritu's" for "Ritu Kumar") scores as a miss. Needs a shared/ PR.
    brandAliases: [],
    competitors: competitors.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
  });

  const byName = new Map(competitors.map((c) => [c.name.toLowerCase(), c.id]));

  await ctx.db.transaction(async (tx) => {
    // Re-parsing a run replaces its mentions rather than appending to them, so
    // a retry — or a deliberate re-score against a newer analyser — is safe.
    await tx.delete(schema.mentions).where(eq(schema.mentions.probeRunId, run.id));

    if (analysis.mentions.length > 0) {
      await tx.insert(schema.mentions).values(
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
  });

  // Record the analyser spend against whichever provider actually served it —
  // not a hardcoded 'anthropic'. The backend is swappable (LLM_PROVIDER), so the
  // ledger has to read the real provider/model back off the returned cost.
  await ctx.db.insert(schema.costEvents).values({
    brandId: brand.id,
    system: 'geo',
    referenceId: run.id,
    provider: analysisCost.provider,
    model: analysisCost.model,
    operation: 'geo:analyze',
    inputTokens: analysisCost.inputTokens ?? null,
    outputTokens: analysisCost.outputTokens ?? null,
    latencyMs: analysisCost.latencyMs ?? null,
    costMicroUsd: analysisCost.costMicroUsd,
  });
}

/**
 * The most recent successful run for this prompt and engine inside the current
 * hour — the same bucket the probe job id uses, so "already probed this hour"
 * means the same thing to the queue and to the pipeline.
 */
async function findRunInBucket(
  ctx: WorkerContext,
  promptId: string,
  engine: AnswerEngine,
): Promise<ProbeRunRow | undefined> {
  const bucketStart = new Date();
  bucketStart.setMinutes(0, 0, 0);

  const [run] = await ctx.db
    .select()
    .from(schema.probeRuns)
    .where(
      and(
        eq(schema.probeRuns.promptId, promptId),
        eq(schema.probeRuns.engine, engine),
        isNull(schema.probeRuns.error),
        gte(schema.probeRuns.runAt, bucketStart),
      ),
    )
    .orderBy(desc(schema.probeRuns.runAt))
    .limit(1);

  return run;
}

async function probeAndPersist(
  ctx: WorkerContext,
  args: {
    client: NonNullable<ReturnType<WorkerContext['ai']['answerEngine']>>;
    prompt: { id: string; text: string; locale: string | null };
    brand: { id: string; name: string };
    engine: string;
  },
): Promise<ProbeRunRow> {
  let answer: Awaited<ReturnType<typeof args.client.ask>>;
  try {
    answer = await args.client.ask({ prompt: args.prompt.text, locale: args.prompt.locale });
  } catch (error) {
    // A failed probe is data, not an absence of data. Recorded before rethrowing
    // so a rate-limited engine is distinguishable from one that simply didn't
    // name the brand — the roll-up excludes these rows rather than counting them
    // as a miss. Every attempt lands, which is what makes a retry storm visible.
    await ctx.db.insert(schema.probeRuns).values({
      promptId: args.prompt.id,
      brandId: args.brand.id,
      engine: args.engine as AnswerEngine,
      model: 'unknown',
      answerText: '',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const [run] = await ctx.db
    .insert(schema.probeRuns)
    .values({
      promptId: args.prompt.id,
      brandId: args.brand.id,
      engine: answer.value.engine,
      model: answer.value.model,
      answerText: answer.value.text,
      citations: answer.value.citations,
      latencyMs: answer.value.latencyMs,
    })
    .returning();
  if (!run) throw new Error('Failed to persist probe run');

  await recordCost(ctx, { brandId: args.brand.id, referenceId: run.id, cost: answer.cost });
  return run;
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
