import { and, eq, gte, isNull, lte, schema } from '@bmas/db';
import { computeGeoScore, type GeoRollupJob } from '@bmas/shared';
import type { WorkerContext } from '../context.js';

/**
 * Collapses raw probe runs into one snapshot per brand per period. The
 * dashboard reads only snapshots, so this is the single place the metric
 * definitions live in code.
 */
export async function runRollup(ctx: WorkerContext, job: GeoRollupJob): Promise<void> {
  const runs = await ctx.db
    .select()
    .from(schema.probeRuns)
    .where(
      and(
        eq(schema.probeRuns.brandId, job.brandId),
        gte(schema.probeRuns.runAt, job.periodStart),
        lte(schema.probeRuns.runAt, job.periodEnd),
      ),
    );

  // Failed probes are stored (see probe.ts) but must not reach the metrics: an
  // engine that rate-limited us didn't decline to mention the brand, and
  // counting it as a miss would quietly depress presence and share of voice.
  const okRuns = runs.filter((run) => run.error === null);
  if (okRuns.length === 0) return;

  const runIds = new Set(okRuns.map((run) => run.id));
  const allMentions = await ctx.db
    .select()
    .from(schema.mentions)
    .where(eq(schema.mentions.brandId, job.brandId));

  const periodMentions = allMentions.filter((mention) => runIds.has(mention.probeRunId));
  const brandMentions = periodMentions.filter((mention) => mention.entityType === 'brand');

  // Presence is measured per run, not per mention: appearing three times in one
  // answer is still one answer that mentioned us.
  const runsWithBrand = new Set(brandMentions.map((mention) => mention.probeRunId));
  const presenceRate = runsWithBrand.size / okRuns.length;

  const averagePosition =
    brandMentions.length > 0
      ? brandMentions.reduce((sum, mention) => sum + mention.position, 0) / brandMentions.length
      : null;

  const shareOfVoice = periodMentions.length > 0 ? brandMentions.length / periodMentions.length : 0;

  const citationRate =
    brandMentions.length > 0
      ? brandMentions.filter((mention) => mention.citedUrl !== null).length / brandMentions.length
      : 0;

  const sentimentScore =
    brandMentions.length > 0
      ? brandMentions.reduce((sum, mention) => sum + sentimentValue(mention.sentiment), 0) /
        brandMentions.length
      : 0;

  const geoScore = computeGeoScore({ presenceRate, averagePosition, shareOfVoice, citationRate });

  // Replace rather than append: the scheduler re-fires this window on every
  // tick, and BullMQ's job-id dedupe only holds until the completed job is
  // evicted. Without this the same period accumulates duplicate snapshots and
  // the trend chart shows steps that never happened.
  await ctx.db.transaction(async (tx) => {
    await tx
      .delete(schema.visibilitySnapshots)
      .where(
        and(
          eq(schema.visibilitySnapshots.brandId, job.brandId),
          isNull(schema.visibilitySnapshots.engine),
          eq(schema.visibilitySnapshots.periodStart, job.periodStart),
          eq(schema.visibilitySnapshots.periodEnd, job.periodEnd),
        ),
      );

    await tx.insert(schema.visibilitySnapshots).values({
      brandId: job.brandId,
      engine: null,
      periodStart: job.periodStart,
      periodEnd: job.periodEnd,
      presenceRate,
      averagePosition,
      shareOfVoice,
      citationRate,
      sentimentScore,
      geoScore,
      promptsProbed: new Set(okRuns.map((run) => run.promptId)).size,
      runsProbed: okRuns.length,
    });
  });
}

function sentimentValue(sentiment: 'positive' | 'neutral' | 'negative'): number {
  if (sentiment === 'positive') return 1;
  if (sentiment === 'negative') return -1;
  return 0;
}
