import { closeDatabase } from '@bmas/db';
import { QUEUES, geoProbeJobSchema, geoRollupJobSchema } from '@bmas/shared';
import { Worker } from 'bullmq';
import { createContext } from './context.js';
import { runProbe } from './pipeline/probe.js';
import { runRollup } from './pipeline/rollup.js';

const ctx = createContext();

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

for (const worker of [probeWorker, rollupWorker]) {
  worker.on('failed', (job, error) => {
    console.error(`[${worker.name}] job ${job?.id} failed:`, error.message);
  });
}

console.warn(`geo-worker started (concurrency ${ctx.concurrency})`);

async function shutdown(signal: string): Promise<void> {
  console.warn(`geo-worker received ${signal}, draining...`);
  // `close()` waits for in-flight jobs so a deploy never drops a paid probe.
  await Promise.allSettled([probeWorker.close(), rollupWorker.close()]);
  await closeDatabase(ctx.db);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
