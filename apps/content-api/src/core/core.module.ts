import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createAiRegistryFromEnv, type AiRegistry } from '@bmas/ai';
import { closeDatabase, createDatabase, type Database } from '@bmas/db';
import { QUEUES } from '@bmas/shared';
import { createAssetUrls, type AssetUrls } from './asset-urls.js';
import { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';

export const DATABASE = Symbol('DATABASE');
export const AI_REGISTRY = Symbol('AI_REGISTRY');
export const GENERATION_QUEUE = Symbol('GENERATION_QUEUE');
export const ASSET_URLS = Symbol('ASSET_URLS');

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
      provide: ASSET_URLS,
      useFactory: (): AssetUrls => {
        const env = loadEnv();
        return createAssetUrls({
          region: env.S3_REGION,
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          expiresInSeconds: env.ASSET_URL_TTL_SECONDS,
          ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
          ...(env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.S3_PUBLIC_ENDPOINT } : {}),
        });
      },
    },
    {
      provide: GENERATION_QUEUE,
      useFactory: () => new Queue(QUEUES.contentGeneration, { connection: redisConnection() }),
    },
  ],
  exports: [DATABASE, AI_REGISTRY, GENERATION_QUEUE, ASSET_URLS],
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
