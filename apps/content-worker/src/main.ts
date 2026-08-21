import { describeError } from '@bmas/ai';
import { closeDatabase } from '@bmas/db';
import {
  QUEUES,
  contentEditJobSchema,
  contentGenerationJobSchema,
  intelligenceResearchJobSchema,
  poolRefreshJobSchema,
  scheduledPostPublishJobSchema,
  trendResearchJobSchema,
  contentPlanDirectiveJobSchema,
  contentPlanItemReplaceJobSchema,
  contentPlanSynthesisJobSchema,
} from '@bmas/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { createContext } from './context.js';
import { runAssetEdit } from './pipeline/asset-edit.js';
import { runGeneration } from './pipeline/generate.js';
import {
  runInstagramInsightsSync,
  scheduleInstagramInsightsSyncTick,
} from './pipeline/instagram-insights-sync.js';
import { runIntelligencePoolRefresh } from './pipeline/intelligence-pool-refresh.js';
import { runIntelligenceResearch } from './pipeline/intelligence-research.js';
import { runPoolSchedulerTick, schedulePoolSchedulerTick } from './pipeline/pool-scheduler.js';
import {
  runResearchSchedulerTick,
  scheduleResearchSchedulerTick,
} from './pipeline/research-scheduler.js';
import { runScheduledPostPublish } from './pipeline/scheduled-post-publish.js';
import { runTrendPoolRefresh } from './pipeline/trend-pool-refresh.js';
import { runPlanDirective } from './pipeline/plan-directive.js';
import { runPlanItemReplace } from './pipeline/plan-item-replace.js';
import { runPlanSynthesis } from './pipeline/plan-synthesis.js';
import { runTrendResearch } from './pipeline/trend-research.js';

const ctx = createContext();

// A fresh MinIO volume has no buckets, so the first upload would fail with
// NoSuchBucket. Done at boot rather than per job so the cost is paid once.
//
// Deliberately non-fatal: an unguarded await here means a misconfigured or
// absent object-storage endpoint (e.g. R2 credentials not set up yet) throws
// before a single queue below is registered — the whole worker, including
// every queue that has nothing to do with storage (trend-research,
// intelligence-research, plan synthesis, ...), silently never starts
// consuming jobs, with no crash and no error visible short of noticing the
// process has zero open sockets. Asset uploads still fail per-job with a
// clear error until storage is configured; that's an acceptable, contained
// failure — every other queue staying dead because of it is not.
try {
  await ctx.storage.ensureBucket();
} catch (error) {
  console.error(
    `[content-worker] object storage unavailable at boot, continuing without it (asset uploads will fail until this is fixed): ${describeError(error)}`,
  );
}

console.warn(`[content-worker] LLM provider: ${ctx.ai.llm().provider}`);
console.warn(
  `[content-worker] web search providers configured: ${
    ctx.ai
      .configuredWebSearches()
      .map((s) => s.provider)
      .join(', ') || '(none)'
  }`,
);

const generationWorker = new Worker(
  QUEUES.contentGeneration,
  async (job) =>
    runGeneration(ctx, contentGenerationJobSchema.parse(job.data), {
      // `attemptsStarted` counts the run in progress (1 on the first pass);
      // `attemptsMade` only counts attempts that have already failed, so it
      // reads 0 here and would mark every first failure as terminal.
      attempt: job.attemptsStarted || job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? 1,
    }),
  { connection: ctx.redis, concurrency: ctx.concurrency },
);

// Fires once per failed attempt. The cause chain is what identifies a transport
// drop; `error.message` alone reduces every one of them to "fetch failed".
generationWorker.on('failed', (job, error) => {
  const attempt = job?.attemptsMade ?? 0;
  const max = job?.opts.attempts ?? 1;
  // An UnrecoverableError consumes no further attempts however many remain, so
  // reporting the arithmetic remainder would promise retries that never come.
  const abandoned = error instanceof UnrecoverableError || error?.name === 'UnrecoverableError';
  const outcome = abandoned
    ? ' (final — not retryable)'
    : attempt >= max
      ? ' (final)'
      : ` — retrying, ${max - attempt} left`;
  console.error(
    `[content:generation] job ${job?.id} attempt ${attempt}/${max} failed${outcome}: ${describeError(error)}`,
  );
});

// Fires once per scheduled post's publish time — a single check-and-post that
// needs no AI/storage context, so concurrency is generous relative to the
// generation worker above.
const scheduledPostPublishWorker = new Worker(
  QUEUES.scheduledPostPublish,
  async (job) => runScheduledPostPublish(ctx, scheduledPostPublishJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: 5 },
);

scheduledPostPublishWorker.on('failed', (job, error) => {
  console.error(`[scheduled-post:publish] job ${job?.id} failed: ${describeError(error)}`);
});

// One search-and-synthesize pass per job, no image spend involved — modest
// concurrency is fine and keeps it from competing with generation for the
// LLM's own rate limits.
//
// A separate Queue producer for content-generation, distinct from
// `generationWorker` above (Worker consumes, Queue produces — same split as
// the scheduler producers further down). Needed here because the Trend
// Opportunity Engine's auto-trigger step (opportunity-trigger.ts) enqueues
// ordinary generation jobs from inside this worker's own trend-research run,
// the same way GenerationsService.enqueue does from content-api.
const contentGenerationProducer = new Queue(QUEUES.contentGeneration, { connection: ctx.redis });

// Auto-triggered opportunities now wrap their generation jobs in a real
// scheduled_campaign/scheduled_posts pair (see opportunity-trigger.ts) so
// they surface in the same approval queue as manually scheduled campaigns.
// That needs a publish-side producer here too — content-api's
// SchedulingService is the usual producer, but this queue is added from
// inside the worker's own trend-research run, same reasoning as
// contentGenerationProducer above.
const scheduledPostPublishProducer = new Queue(QUEUES.scheduledPostPublish, {
  connection: ctx.redis,
});

const trendResearchWorker = new Worker(
  QUEUES.trendResearch,
  async (job) =>
    runTrendResearch(
      ctx,
      trendResearchJobSchema.parse(job.data),
      contentGenerationProducer,
      scheduledPostPublishProducer,
    ),
  { connection: ctx.redis, concurrency: 2 },
);

trendResearchWorker.on('failed', (job, error) => {
  console.error(`[trend-research] job ${job?.id} failed: ${describeError(error)}`);
});

// The leads/business-intelligence counterpart to trend research, same
// concurrency reasoning: one search-and-synthesize pass, no image spend.
const intelligenceResearchWorker = new Worker(
  QUEUES.intelligenceResearch,
  async (job) => runIntelligenceResearch(ctx, intelligenceResearchJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: 2 },
);

intelligenceResearchWorker.on('failed', (job, error) => {
  console.error(`[intelligence-research] job ${job?.id} failed: ${describeError(error)}`);
});

// Layer A — one search+synthesize pass per category/national bucket, shared
// by every brand in scope (see trend-pool-refresh.ts / intelligence-pool-
// refresh.ts). Same modest concurrency reasoning as the Layer B workers
// above; there are only ~13 buckets per kind, so this never needs to be high.
const trendPoolResearchWorker = new Worker(
  QUEUES.trendPoolResearch,
  async (job) => runTrendPoolRefresh(ctx, poolRefreshJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: 2 },
);

trendPoolResearchWorker.on('failed', (job, error) => {
  console.error(`[trend-pool-refresh] job ${job?.id} failed: ${describeError(error)}`);
});

const intelligencePoolResearchWorker = new Worker(
  QUEUES.intelligencePoolResearch,
  async (job) => runIntelligencePoolRefresh(ctx, poolRefreshJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: 2 },
);

intelligencePoolResearchWorker.on('failed', (job, error) => {
  console.error(`[intelligence-pool-refresh] job ${job?.id} failed: ${describeError(error)}`);
});

// The planning agents. Both are strategy-level LLM calls rather than image
// work, so they are cheap to run and there is no reason to serialise them
// beyond keeping one brand's plan writes from racing each other — which the
// planner's own transaction already handles.
const planSynthesisWorker = new Worker(
  QUEUES.contentPlanSynthesis,
  async (job) => {
    await runPlanSynthesis(ctx, contentPlanSynthesisJobSchema.parse(job.data));
  },
  { connection: ctx.redis, concurrency: 2 },
);

planSynthesisWorker.on('failed', (job, error) => {
  console.error(`[plan] job ${job?.id} failed: ${describeError(error)}`);
});

// Concurrency 1: a directive rewrites the whole plan, and two of a brand's
// messages processed at once would each supersede the other's plan, leaving
// the user's earlier instruction silently discarded. Ordering is the feature
// here, not throughput.
const planDirectiveWorker = new Worker(
  QUEUES.contentPlanDirective,
  async (job) => runPlanDirective(ctx, contentPlanDirectiveJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: 1 },
);

planDirectiveWorker.on('failed', (job, error) => {
  console.error(`[plan-directive] job ${job?.id} failed: ${describeError(error)}`);
});

const planItemReplaceWorker = new Worker(
  QUEUES.contentPlanItemReplace,
  async (job) => {
    await runPlanItemReplace(ctx, contentPlanItemReplaceJobSchema.parse(job.data));
  },
  // Serialised per process: two replacements for the same plan drafted at once
  // would each be blind to the other's new item, which is exactly the
  // duplicate this feature exists to prevent.
  { connection: ctx.redis, concurrency: 1 },
);

planItemReplaceWorker.on('failed', (job, error) => {
  console.error(`[plan-replace] job ${job?.id} failed: ${describeError(error)}`);
});

// Producer-side handles for the scheduler ticks to enqueue into. Separate
// from the Worker instances above (which only consume) — BullMQ's Queue and
// Worker are different roles on the same queue name, and a tick needs to add
// jobs, not process them.
const trendResearchProducer = new Queue(QUEUES.trendResearch, { connection: ctx.redis });
const intelligenceResearchProducer = new Queue(QUEUES.intelligenceResearch, {
  connection: ctx.redis,
});
const researchSchedulerQueue = new Queue(QUEUES.researchScheduler, { connection: ctx.redis });
const trendPoolResearchProducer = new Queue(QUEUES.trendPoolResearch, { connection: ctx.redis });
const intelligencePoolResearchProducer = new Queue(QUEUES.intelligencePoolResearch, {
  connection: ctx.redis,
});
const poolSchedulerQueue = new Queue(QUEUES.poolScheduler, { connection: ctx.redis });

// One repeatable job each, registered idempotently on every boot (see
// scheduleResearchSchedulerTick's own comment on why that's safe).
await scheduleResearchSchedulerTick(researchSchedulerQueue);
await schedulePoolSchedulerTick(poolSchedulerQueue);

const researchSchedulerWorker = new Worker(
  QUEUES.researchScheduler,
  async () => runResearchSchedulerTick(ctx, trendResearchProducer, intelligenceResearchProducer),
  { connection: ctx.redis, concurrency: 1 },
);

researchSchedulerWorker.on('failed', (job, error) => {
  console.error(`[research-scheduler] tick ${job?.id} failed: ${describeError(error)}`);
});

const poolSchedulerWorker = new Worker(
  QUEUES.poolScheduler,
  async () =>
    runPoolSchedulerTick(ctx, trendPoolResearchProducer, intelligencePoolResearchProducer),
  { connection: ctx.redis, concurrency: 1 },
);

poolSchedulerWorker.on('failed', (job, error) => {
  console.error(`[pool-scheduler] tick ${job?.id} failed: ${describeError(error)}`);
});

// Self-contained tick: unlike researchScheduler/poolScheduler, this does not
// fan out into another queue — the tick's own processor does the DB read and
// the Instagram Graph API calls directly. See instagram-insights-sync.ts's
// module comment for why that lives here rather than as an HTTP call back
// into content-api.
const instagramInsightsSyncQueue = new Queue(QUEUES.instagramInsightsSync, {
  connection: ctx.redis,
});
await scheduleInstagramInsightsSyncTick(instagramInsightsSyncQueue);

const instagramInsightsSyncWorker = new Worker(
  QUEUES.instagramInsightsSync,
  async () => runInstagramInsightsSync(ctx),
  { connection: ctx.redis, concurrency: 1 },
);

instagramInsightsSyncWorker.on('failed', (job, error) => {
  console.error(`[instagram-insights-sync] tick ${job?.id} failed: ${describeError(error)}`);
});

// One provider call per job. `runAssetEdit` never rethrows (see its own
// comment — attempts:1 is a deliberate, capped user-facing budget), so
// 'failed' here would only ever fire on something outside that try/catch,
// e.g. the job payload itself failing to parse.
const contentEditWorker = new Worker(
  QUEUES.contentEdit,
  async (job) => runAssetEdit(ctx, contentEditJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: 2 },
);

contentEditWorker.on('failed', (job, error) => {
  console.error(`[asset-edit] job ${job?.id} failed: ${describeError(error)}`);
});

console.warn(`content-worker started (concurrency ${ctx.concurrency})`);

/** Draining waits on Redis, so an unreachable Redis makes `close()` hang
 *  indefinitely. A worker stuck that way survives SIGTERM, and once Redis comes
 *  back it competes for jobs against the current build — with whatever stale env
 *  it was launched with. That is not hypothetical: three such orphans, one still
 *  pointed at the retired mock provider, were failing live jobs. Draining is
 *  still worth attempting; outliving the signal is not. */
const SHUTDOWN_GRACE_MS = 15_000;

async function shutdown(signal: string): Promise<void> {
  console.warn(`content-worker received ${signal}, draining...`);

  const forced = setTimeout(() => {
    console.error(`content-worker did not drain within ${SHUTDOWN_GRACE_MS}ms — exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forced.unref();

  try {
    // Waits for in-flight generations so a deploy never abandons a paid job.
    await Promise.all([
      generationWorker.close(),
      scheduledPostPublishWorker.close(),
      trendResearchWorker.close(),
      intelligenceResearchWorker.close(),
      trendPoolResearchWorker.close(),
      intelligencePoolResearchWorker.close(),
      researchSchedulerWorker.close(),
      poolSchedulerWorker.close(),
      contentEditWorker.close(),
      planSynthesisWorker.close(),
      planDirectiveWorker.close(),
      planItemReplaceWorker.close(),
      instagramInsightsSyncWorker.close(),
      trendResearchProducer.close(),
      intelligenceResearchProducer.close(),
      researchSchedulerQueue.close(),
      trendPoolResearchProducer.close(),
      intelligencePoolResearchProducer.close(),
      poolSchedulerQueue.close(),
      contentGenerationProducer.close(),
      scheduledPostPublishProducer.close(),
      instagramInsightsSyncQueue.close(),
    ]);
    await closeDatabase(ctx.db);
  } catch (error) {
    console.error(`content-worker shutdown error: ${describeError(error)}`);
  } finally {
    clearTimeout(forced);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
