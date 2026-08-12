import { closeDatabase } from '@bmas/db';
import { QUEUES, geoProbeJobSchema, geoRollupJobSchema, geoSweepJobSchema } from '@bmas/shared';
import { Queue, Worker } from 'bullmq';
import { createContext } from './context.js';
import { runProbe } from './pipeline/probe.js';
import { runRollup } from './pipeline/rollup.js';
import { enqueueRollups, sweepPrompt } from './pipeline/sweep.js';
import { ensureRollupScheduler, syncPromptSchedulers } from './scheduler.js';

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
    const brands = await enqueueRollups(ctx, rollupQueue);
    console.warn(`[sweep] roll-up tick: enqueued ${brands} brand(s)`);
  },
  // Ticks are cheap and ordering-sensitive; the fan-out is what parallelises.
  { connection: ctx.redis, concurrency: 1 },
);

for (const worker of [probeWorker, rollupWorker, sweepWorker]) {
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
await sync();
const syncTimer = setInterval(() => void sync(), ctx.scheduler.syncIntervalMs);

console.warn(
  `geo-worker started (concurrency ${ctx.concurrency}, roll-up '${ctx.scheduler.rollupCron}' over ${ctx.scheduler.rollupWindowDays}d)`,
);

async function shutdown(signal: string): Promise<void> {
  console.warn(`geo-worker received ${signal}, draining...`);
  clearInterval(syncTimer);
  // `close()` waits for in-flight jobs so a deploy never drops a paid probe.
  await Promise.allSettled([probeWorker.close(), rollupWorker.close(), sweepWorker.close()]);
  await Promise.allSettled([probeQueue.close(), rollupQueue.close(), sweepQueue.close()]);
  await closeDatabase(ctx.db);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
