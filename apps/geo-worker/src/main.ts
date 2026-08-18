import { closeDatabase } from '@bmas/db';
import {
  QUEUES,
  geoProbeJobSchema,
  geoPromptRefreshJobSchema,
  geoRollupJobSchema,
  geoSweepJobSchema,
} from '@bmas/shared';
import { Queue, Worker } from 'bullmq';
import { createContext } from './context.js';
import { runProbe } from './pipeline/probe.js';
import { runRollup } from './pipeline/rollup.js';
import {
  regenerateSuggestedPrompts,
  runPromptSuggestionSweep,
} from './pipeline/prompt-suggestions.js';
import { enqueueRollups, sweepPrompt } from './pipeline/sweep.js';
import {
  ensurePromptSuggestionScheduler,
  ensureRollupScheduler,
  syncPromptSchedulers,
} from './scheduler.js';

const ctx = createContext();

// The worker both consumes and produces: sweep ticks fan out into these two.
const probeQueue = new Queue(QUEUES.geoProbe, { connection: ctx.redis });
const rollupQueue = new Queue(QUEUES.geoRollup, { connection: ctx.redis });
const sweepQueue = new Queue(QUEUES.geoSweep, { connection: ctx.redis });

const probeWorker = new Worker(
  QUEUES.geoProbe,
  async (job) => runProbe(ctx, geoProbeJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: ctx.concurrency },
);

const rollupWorker = new Worker(
  QUEUES.geoRollup,
  async (job) => runRollup(ctx, geoRollupJobSchema.parse(job.data)),
  // Roll-ups write one row per brand-period; serialising avoids duplicate
  // snapshots when a sweep finishes and a scheduled roll-up fire at once.
  { connection: ctx.redis, concurrency: 1 },
);

const sweepWorker = new Worker(
  QUEUES.geoSweep,
  async (job) => {
    const tick = geoSweepJobSchema.parse(job.data);
    if (tick.kind === 'prompt') {
      const enqueued = await sweepPrompt(ctx, probeQueue, tick.promptId);
      console.warn(`[sweep] prompt ${tick.promptId}: enqueued ${enqueued} probe(s)`);
      return;
    }
    if (tick.kind === 'prompt-suggestions') {
      const brands = await runPromptSuggestionSweep(ctx);
      console.warn(`[sweep] prompt-suggestions tick: topped up ${brands} brand(s)`);
      return;
    }
    const brands = await enqueueRollups(ctx, rollupQueue);
    console.warn(`[sweep] roll-up tick: enqueued ${brands} brand(s)`);
  },
  // Ticks are cheap and ordering-sensitive; the fan-out is what parallelises.
  { connection: ctx.redis, concurrency: 1 },
);

const promptRefreshWorker = new Worker(
  QUEUES.geoPromptRefresh,
  async (job) => {
    const { brandId } = geoPromptRefreshJobSchema.parse(job.data);
    const { retired, created } = await regenerateSuggestedPrompts(ctx, brandId);
    console.warn(
      `[prompt-refresh] brand ${brandId}: retired ${retired}, created ${created}`,
    );
  },
  // One brand's refresh at a time. Two concurrent refreshes of the SAME brand
  // would each draft against the other's soon-to-be-retired set and then both
  // insert, leaving twelve live prompts instead of six. geo-api also keys the
  // job per brand so a double-tap collapses, but that only dedupes what is
  // still waiting — this is what bounds the overlap.
  { connection: ctx.redis, concurrency: 1 },
);

for (const worker of [probeWorker, rollupWorker, sweepWorker, promptRefreshWorker]) {
  worker.on('failed', (job, error) => {
    console.error(`[${worker.name}] job ${job?.id} failed:`, error.message);
  });
}

async function sync(): Promise<void> {
  try {
    const result = await syncPromptSchedulers(ctx, sweepQueue);
    if (result.removed > 0 || result.invalid.length > 0) {
      console.warn(
        `[scheduler] ${result.active} active, ${result.removed} removed, ${result.invalid.length} invalid`,
      );
    }
  } catch (error) {
    // A sync failure is recoverable — existing schedulers keep firing from
    // Redis, and the next tick re-reads. Crashing the worker would not be.
    console.error('[scheduler] sync failed:', error instanceof Error ? error.message : error);
  }
}

await ensureRollupScheduler(ctx, sweepQueue);
await ensurePromptSuggestionScheduler(ctx, sweepQueue);
await sync();
const syncTimer = setInterval(() => void sync(), ctx.scheduler.syncIntervalMs);

console.warn(
  `geo-worker started (concurrency ${ctx.concurrency}, roll-up '${ctx.scheduler.rollupCron}' over ${ctx.scheduler.rollupWindowDays}d)`,
);

async function shutdown(signal: string): Promise<void> {
  console.warn(`geo-worker received ${signal}, draining...`);
  clearInterval(syncTimer);
  // `close()` waits for in-flight jobs so a deploy never drops a paid probe.
  await Promise.allSettled([
    probeWorker.close(),
    rollupWorker.close(),
    sweepWorker.close(),
    promptRefreshWorker.close(),
  ]);
  await Promise.allSettled([probeQueue.close(), rollupQueue.close(), sweepQueue.close()]);
  await closeDatabase(ctx.db);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
