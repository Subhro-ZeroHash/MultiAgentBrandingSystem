import { describeError } from '@bmas/ai';
import { closeDatabase } from '@bmas/db';
import { QUEUES, contentGenerationJobSchema } from '@bmas/shared';
import { Worker } from 'bullmq';
import { createContext } from './context.js';
import { runGeneration } from './pipeline/generate.js';

const ctx = createContext();

// A fresh MinIO volume has no buckets, so the first upload would fail with
// NoSuchBucket. Done at boot rather than per job so the cost is paid once.
await ctx.storage.ensureBucket();

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
  const terminal = attempt >= max ? ' (final)' : ` — retrying, ${max - attempt} left`;
  console.error(
    `[content:generation] job ${job?.id} attempt ${attempt}/${max} failed${terminal}: ${describeError(error)}`,
  );
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
    console.error(
      `content-worker did not drain within ${SHUTDOWN_GRACE_MS}ms — exiting anyway`,
    );
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forced.unref();

  try {
    // Waits for in-flight generations so a deploy never abandons a paid job.
    await generationWorker.close();
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
