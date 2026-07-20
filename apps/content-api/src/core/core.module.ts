import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createAiRegistryFromEnv, type AiRegistry } from '@bmas/ai';
import { closeDatabase, createDatabase, type Database } from '@bmas/db';
import { QUEUES } from '@bmas/shared';
import { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';

export const DATABASE = Symbol('DATABASE');
export const AI_REGISTRY = Symbol('AI_REGISTRY');
export const GENERATION_QUEUE = Symbol('GENERATION_QUEUE');

function redisConnection() {
  const url = new URL(loadEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
  };
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database => createDatabase({ url: loadEnv().DATABASE_URL }),
    },
    { provide: AI_REGISTRY, useFactory: (): AiRegistry => createAiRegistryFromEnv() },
    {
      provide: GENERATION_QUEUE,
      useFactory: () => new Queue(QUEUES.contentGeneration, { connection: redisConnection() }),
    },
  ],
  exports: [DATABASE, AI_REGISTRY, GENERATION_QUEUE],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GENERATION_QUEUE) private readonly generationQueue: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([closeDatabase(this.db), this.generationQueue.close()]);
  }
}
