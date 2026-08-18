import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, schema, type Database } from '@bmas/db';
import { isEngineActive, type AnswerEngine } from '@bmas/shared';
import { assertBrandOwned } from '../common/assert-brand-owned.js';
import { DATABASE } from '../core/core.module.js';

export interface EngineVisibility {
  engine: AnswerEngine;
  /** Whether this deployment actually probes this engine yet — see
   *  ACTIVE_ANSWER_ENGINES. The client renders "Coming soon" when false
   *  instead of an empty score, since "not built yet" and "built, no data
   *  yet" are different states a zero would blur together. */
  active: boolean;
  runsProbed: number;
  promptsProbed: number;
  /** Null, not 0, when this engine has never been probed for this brand —
   *  same "absence over a fake zero" rule as VisibilitySnapshot. */
  presenceRate: number | null;
  lastProbedAt: string | null;
}

@Injectable()
export class VisibilityService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Latest snapshot per brand — what the dashboard headline reads.
   *
   * Ordered by `periodEnd`, not `periodStart`: "latest" means the snapshot
   * covering the most recent measurement period. Ordering by `periodStart`
   * ranks a narrow window above a wider one that ends later — so widening
   * `GEO_ROLLUP_WINDOW_DAYS` would leave the dashboard pinned to a stale
   * snapshot until the new window's start date overtook the old one.
   * `computedAt` breaks ties when the same period is re-scored.
   */
  async latest(brandId: string, ownerId: string) {
    await assertBrandOwned(this.db, brandId, ownerId);
    const [snapshot] = await this.db
      .select()
      .from(schema.visibilitySnapshots)
      .where(eq(schema.visibilitySnapshots.brandId, brandId))
      .orderBy(
        desc(schema.visibilitySnapshots.periodEnd),
        desc(schema.visibilitySnapshots.computedAt),
      )
      .limit(1);

    return snapshot ?? null;
  }

  /** Score history for the trend chart. */
  async history(brandId: string, since: Date, ownerId: string) {
    await assertBrandOwned(this.db, brandId, ownerId);
    return this.db
      .select()
      .from(schema.visibilitySnapshots)
      .where(
        and(
          eq(schema.visibilitySnapshots.brandId, brandId),
          gte(schema.visibilitySnapshots.periodStart, since),
        ),
      )
      .orderBy(schema.visibilitySnapshots.periodStart);
  }

  /** Recent raw answers, for the "why did we score that" drill-down. */
  async recentRuns(brandId: string, limit: number, ownerId: string) {
    await assertBrandOwned(this.db, brandId, ownerId);
    return this.db
      .select()
      .from(schema.probeRuns)
      .where(eq(schema.probeRuns.brandId, brandId))
      .orderBy(desc(schema.probeRuns.runAt))
      .limit(limit);
  }

  /**
   * The structured entity extraction behind one probe run — what actually
   * moved (or didn't move) that run's contribution to the score. Scoped
   * through the run's own `brandId`, not the `:brandId` route param, so a
   * mismatched pair (someone else's run id under your brand's path) 404s
   * instead of silently returning another brand's mentions.
   */
  async mentionsForRun(brandId: string, runId: string, ownerId: string) {
    await assertBrandOwned(this.db, brandId, ownerId);

    const [run] = await this.db
      .select({ id: schema.probeRuns.id, brandId: schema.probeRuns.brandId })
      .from(schema.probeRuns)
      .where(eq(schema.probeRuns.id, runId))
      .limit(1);
    if (!run || run.brandId !== brandId) {
      throw new NotFoundException(`Probe run ${runId} not found`);
    }

    return this.db
      .select()
      .from(schema.mentions)
      .where(eq(schema.mentions.probeRunId, runId))
      .orderBy(schema.mentions.position);
  }

  /**
   * Recent times an engine actually named the tracked brand, newest first —
   * the "AI Mentions Tracker" feed. Scoped to `entityType = 'brand'` (not
   * competitor mentions) and joined to `probe_runs` for the engine + timestamp
   * a mention row alone doesn't carry, so a client never needs one request per
   * run to build this list.
   */
  async recentMentions(brandId: string, limit: number, ownerId: string) {
    await assertBrandOwned(this.db, brandId, ownerId);
    return this.db
      .select({
        id: schema.mentions.id,
        probeRunId: schema.mentions.probeRunId,
        entityName: schema.mentions.entityName,
        position: schema.mentions.position,
        sentiment: schema.mentions.sentiment,
        excerpt: schema.mentions.excerpt,
        citedUrl: schema.mentions.citedUrl,
        engine: schema.probeRuns.engine,
        runAt: schema.probeRuns.runAt,
      })
      .from(schema.mentions)
      .innerJoin(schema.probeRuns, eq(schema.mentions.probeRunId, schema.probeRuns.id))
      .where(and(eq(schema.mentions.brandId, brandId), eq(schema.mentions.entityType, 'brand')))
      .orderBy(desc(schema.probeRuns.runAt))
      .limit(limit);
  }

  /**
   * One row per AI model — `chatgpt`, `perplexity`, `gemini`, `claude`,
   * `copilot`, `ai_overviews` — computed live from `probe_runs`/`mentions`
   * rather than read from `visibility_snapshots`: the roll-up only ever
   * writes the engine-collapsed row (see rollup.ts), so a per-engine number
   * has no pre-aggregated source. Every engine in the enum is returned, not
   * just ones this brand has probed, so the client can render "Coming soon"
   * for engines this deployment doesn't run yet without knowing that list
   * itself — `active` carries it.
   */
  async byEngine(brandId: string, ownerId: string): Promise<EngineVisibility[]> {
    await assertBrandOwned(this.db, brandId, ownerId);

    const allRuns = await this.db
      .select({
        id: schema.probeRuns.id,
        engine: schema.probeRuns.engine,
        promptId: schema.probeRuns.promptId,
        runAt: schema.probeRuns.runAt,
        error: schema.probeRuns.error,
      })
      .from(schema.probeRuns)
      .where(eq(schema.probeRuns.brandId, brandId));
    // Same rule as rollup.ts: a failed probe (rate-limited, timed out) didn't
    // observe the engine declining to mention the brand, so it must not
    // count toward that engine's presence rate.
    const runs = allRuns.filter((run) => run.error === null);

    const brandRuns = await this.db
      .select({ probeRunId: schema.mentions.probeRunId })
      .from(schema.mentions)
      .where(and(eq(schema.mentions.brandId, brandId), eq(schema.mentions.entityType, 'brand')));
    const runsWithBrand = new Set(brandRuns.map((row) => row.probeRunId));

    const buckets = new Map<
      AnswerEngine,
      { runs: number; brandRuns: number; prompts: Set<string>; lastProbedAt: Date | null }
    >();
    for (const engine of schema.answerEngine.enumValues) {
      buckets.set(engine, { runs: 0, brandRuns: 0, prompts: new Set(), lastProbedAt: null });
    }

    for (const run of runs) {
      const bucket = buckets.get(run.engine);
      if (!bucket) continue;
      bucket.runs += 1;
      bucket.prompts.add(run.promptId);
      if (runsWithBrand.has(run.id)) bucket.brandRuns += 1;
      if (!bucket.lastProbedAt || run.runAt > bucket.lastProbedAt) bucket.lastProbedAt = run.runAt;
    }

    return schema.answerEngine.enumValues.map((engine): EngineVisibility => {
      const bucket = buckets.get(engine)!;
      return {
        engine,
        active: isEngineActive(engine),
        runsProbed: bucket.runs,
        promptsProbed: bucket.prompts.size,
        presenceRate: bucket.runs > 0 ? bucket.brandRuns / bucket.runs : null,
        lastProbedAt: bucket.lastProbedAt ? bucket.lastProbedAt.toISOString() : null,
      };
    });
  }
}
