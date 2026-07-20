import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createAiRegistryFromEnv, type AiRegistry } from '@bmas/ai';
import { closeDatabase, createDatabase, type Database } from '@bmas/db';
import { QUEUES } from '@bmas/shared';
import { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';

export const DATABASE = Symbol('DATABASE');
export const AI_REGISTRY = Symbol('AI_REGISTRY');
export const PROBE_QUEUE = Symbol('PROBE_QUEUE');
export const ROLLUP_QUEUE = Symbol('ROLLUP_QUEUE');

function redisConnection() {
  const url = new URL(loadEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
  };
}

/**
 * Infrastructure singletons. Global so feature modules inject them without
 * re-importing; swapping any of them is a change here and nowhere else.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database => createDatabase({ url: loadEnv().DATABASE_URL }),
    },
    {
      provide: AI_REGISTRY,
      useFactory: (): AiRegistry => createAiRegistryFromEnv(),
    },
    {
      provide: PROBE_QUEUE,
      useFactory: () => new Queue(QUEUES.geoProbe, { connection: redisConnection() }),
    },
    {
      provide: ROLLUP_QUEUE,
      useFactory: () => new Queue(QUEUES.geoRollup, { connection: redisConnection() }),
    },
  ],
  exports: [DATABASE, AI_REGISTRY, PROBE_QUEUE, ROLLUP_QUEUE],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PROBE_QUEUE) private readonly probeQueue: Queue,
    @Inject(ROLLUP_QUEUE) private readonly rollupQueue: Queue,
  ) {}

  /** Without this, `nest start --watch` leaks a pool and two Redis clients per reload. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      closeDatabase(this.db),
      this.probeQueue.close(),
      this.rollupQueue.close(),
    ]);
  }
}
