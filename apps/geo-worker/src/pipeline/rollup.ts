import { and, eq, gte, isNull, lte, recordFeedbackSignal, schema, type MentionRow } from '@bmas/db';
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
  const promptsProbed = new Set(okRuns.map((run) => run.promptId)).size;

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
      promptsProbed,
      runsProbed: okRuns.length,
    });
  });

  await recordCompetitiveSignal(ctx, job, periodMentions, presenceRate, promptsProbed);
}

function sentimentValue(sentiment: 'positive' | 'neutral' | 'negative'): number {
  if (sentiment === 'positive') return 1;
  if (sentiment === 'negative') return -1;
  return 0;
}

/**
 * Surfaces the rollup's competitive finding into Brand Brain (`content.brand_preferences`),
 * so a future content brief can see which competitor is winning the AI-answer
 * visibility this brand isn't — the missing half of "measure it, then act on
 * it." Before this, GEO and content generation shared nothing but the Brand
 * Kit; `geo.mentions` never reached `context-manager.ts` in either direction.
 *
 * `recordFeedbackSignal` is otherwise called only from direct user actions
 * (approve/reject/regenerate, a dismissed trend lead); this is the first
 * caller driven by an aggregate finding rather than a click, which is exactly
 * the case its own doc comment anticipates ("Phase 5's analyzer, which sees
 * aggregates, is what should record high-confidence findings"). `kind:
 * 'rejected'` is borrowed purely for its topic-dimension confidence (0.5),
 * mirroring the same borrow `intelligence.service.ts` already does for a
 * dismissed lead — this isn't a rejection of anything, it's a measured gap.
 *
 * One row per rollup period, not per mention: a competitor named once in one
 * answer is noise, and per-mention writes would flood the append-only log
 * with restatements of the same finding. Skipped entirely when no competitor
 * was named this period — nothing to learn.
 */
async function recordCompetitiveSignal(
  ctx: WorkerContext,
  job: GeoRollupJob,
  periodMentions: MentionRow[],
  presenceRate: number,
  promptsProbed: number,
): Promise<void> {
  const competitorMentions = periodMentions.filter(
    (mention) => mention.entityType === 'competitor',
  );
  if (competitorMentions.length === 0) return;

  const countsByName = new Map<string, number>();
  for (const mention of competitorMentions) {
    countsByName.set(mention.entityName, (countsByName.get(mention.entityName) ?? 0) + 1);
  }
  const [topCompetitor, topCount] = [...countsByName.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const competitorShare = topCount / competitorMentions.length;

  await recordFeedbackSignal(ctx.db, {
    brandId: job.brandId,
    kind: 'rejected',
    type: 'topic',
    summary:
      `AI answer engines named "${topCompetitor}" in ${topCount} of ${competitorMentions.length} ` +
      `competitor mentions across ${promptsProbed} tracked prompt(s) this period, while this ` +
      `brand's own presence rate was ${Math.round(presenceRate * 100)}%. Consider content that ` +
      `differentiates from ${topCompetitor} on the topics these prompts cover.`,
    value: topCompetitor,
    detail: {
      source: 'geo-rollup',
      periodStart: job.periodStart.toISOString(),
      periodEnd: job.periodEnd.toISOString(),
      competitorShare: Math.round(competitorShare * 100) / 100,
      presenceRate,
      promptsProbed,
    },
  });
}
