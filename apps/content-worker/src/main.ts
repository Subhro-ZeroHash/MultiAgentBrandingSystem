import { closeDatabase } from '@bmas/db';
import { QUEUES, contentGenerationJobSchema } from '@bmas/shared';
import { Worker } from 'bullmq';
import { createContext } from './context.js';
import { runGeneration } from './pipeline/generate.js';

const ctx = createContext();

const generationWorker = new Worker(
  QUEUES.contentGeneration,
  async (job) => runGeneration(ctx, contentGenerationJobSchema.parse(job.data)),
  { connection: ctx.redis, concurrency: ctx.concurrency },
);

generationWorker.on('failed', (job, error) => {
  console.error(`[content:generation] job ${job?.id} failed:`, error.message);
});

console.warn(`content-worker started (concurrency ${ctx.concurrency})`);

async function shutdown(signal: string): Promise<void> {
  console.warn(`content-worker received ${signal}, draining...`);
  // Waits for in-flight generations so a deploy never abandons a paid job.
  await generationWorker.close();
  await closeDatabase(ctx.db);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
