import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createAiRegistryFromEnv, type AiRegistry } from '@bmas/ai';
import { closeDatabase, createDatabase, type Database } from '@bmas/db';
import { QUEUES } from '@bmas/shared';
import { createAssetUrls, type AssetUrls } from './asset-urls.js';
import { createObjectStore, type ObjectStore } from './object-store.js';
import { Queue } from 'bullmq';
import { loadEnv } from '../config/env.js';

export const DATABASE = Symbol('DATABASE');
export const AI_REGISTRY = Symbol('AI_REGISTRY');
export const GENERATION_QUEUE = Symbol('GENERATION_QUEUE');
export const VIDEO_GENERATION_QUEUE = Symbol('VIDEO_GENERATION_QUEUE');
export const SCHEDULED_POST_PUBLISH_QUEUE = Symbol('SCHEDULED_POST_PUBLISH_QUEUE');
export const TREND_RESEARCH_QUEUE = Symbol('TREND_RESEARCH_QUEUE');
export const INTELLIGENCE_RESEARCH_QUEUE = Symbol('INTELLIGENCE_RESEARCH_QUEUE');
export const CONTENT_EDIT_QUEUE = Symbol('CONTENT_EDIT_QUEUE');
export const PLAN_SYNTHESIS_QUEUE = Symbol('PLAN_SYNTHESIS_QUEUE');
export const PLAN_DIRECTIVE_QUEUE = Symbol('PLAN_DIRECTIVE_QUEUE');
export const PLAN_ITEM_REPLACE_QUEUE = Symbol('PLAN_ITEM_REPLACE_QUEUE');
export const INSTAGRAM_INSIGHTS_SYNC_QUEUE = Symbol('INSTAGRAM_INSIGHTS_SYNC_QUEUE');
export const ASSET_URLS = Symbol('ASSET_URLS');
export const OBJECT_STORE = Symbol('OBJECT_STORE');

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
      useFactory: (): Database => {
        const env = loadEnv();
        // Supabase's session pooler caps total concurrent clients at 15
        // (pool_size in its own dashboard) — shared across every service that
        // connects, not per-service. Each of the 4 backend processes needs an
        // explicit, small `max` here or the combined default (10 each) blows
        // past that ceiling under any real concurrent load, surfacing as
        // random "max clients reached" failures rather than a clean error at
        // the one place that's actually over budget.
        return createDatabase({
          url: env.DATABASE_URL,
          ssl: env.NODE_ENV === 'production',
          max: 4,
        });
      },
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
      provide: OBJECT_STORE,
      useFactory: (): ObjectStore => {
        const env = loadEnv();
        return createObjectStore({
          region: env.S3_REGION,
          bucket: env.S3_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        });
      },
    },
    {
      provide: GENERATION_QUEUE,
      useFactory: () => new Queue(QUEUES.contentGeneration, { connection: redisConnection() }),
    },
    {
      provide: VIDEO_GENERATION_QUEUE,
      useFactory: () => new Queue(QUEUES.videoGeneration, { connection: redisConnection() }),
    },
    {
      provide: SCHEDULED_POST_PUBLISH_QUEUE,
      useFactory: () => new Queue(QUEUES.scheduledPostPublish, { connection: redisConnection() }),
    },
    {
      provide: TREND_RESEARCH_QUEUE,
      useFactory: () => new Queue(QUEUES.trendResearch, { connection: redisConnection() }),
    },
    {
      provide: INTELLIGENCE_RESEARCH_QUEUE,
      useFactory: () => new Queue(QUEUES.intelligenceResearch, { connection: redisConnection() }),
    },
    {
      provide: CONTENT_EDIT_QUEUE,
      useFactory: () => new Queue(QUEUES.contentEdit, { connection: redisConnection() }),
    },
    {
      provide: PLAN_SYNTHESIS_QUEUE,
      useFactory: () => new Queue(QUEUES.contentPlanSynthesis, { connection: redisConnection() }),
    },
    {
      provide: PLAN_DIRECTIVE_QUEUE,
      useFactory: () => new Queue(QUEUES.contentPlanDirective, { connection: redisConnection() }),
    },
    {
      provide: PLAN_ITEM_REPLACE_QUEUE,
      useFactory: () => new Queue(QUEUES.contentPlanItemReplace, { connection: redisConnection() }),
    },
    {
      provide: INSTAGRAM_INSIGHTS_SYNC_QUEUE,
      useFactory: () => new Queue(QUEUES.instagramInsightsSync, { connection: redisConnection() }),
    },
  ],
  exports: [
    DATABASE,
    AI_REGISTRY,
    GENERATION_QUEUE,
    VIDEO_GENERATION_QUEUE,
    SCHEDULED_POST_PUBLISH_QUEUE,
    TREND_RESEARCH_QUEUE,
    INTELLIGENCE_RESEARCH_QUEUE,
    CONTENT_EDIT_QUEUE,
    PLAN_SYNTHESIS_QUEUE,
    PLAN_DIRECTIVE_QUEUE,
    PLAN_ITEM_REPLACE_QUEUE,
    INSTAGRAM_INSIGHTS_SYNC_QUEUE,
    ASSET_URLS,
    OBJECT_STORE,
  ],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GENERATION_QUEUE) private readonly generationQueue: Queue,
    @Inject(VIDEO_GENERATION_QUEUE) private readonly videoGenerationQueue: Queue,
    @Inject(SCHEDULED_POST_PUBLISH_QUEUE) private readonly scheduledPostPublishQueue: Queue,
    @Inject(TREND_RESEARCH_QUEUE) private readonly trendResearchQueue: Queue,
    @Inject(INTELLIGENCE_RESEARCH_QUEUE) private readonly intelligenceResearchQueue: Queue,
    @Inject(CONTENT_EDIT_QUEUE) private readonly contentEditQueue: Queue,
    @Inject(PLAN_SYNTHESIS_QUEUE) private readonly planSynthesisQueue: Queue,
    @Inject(PLAN_DIRECTIVE_QUEUE) private readonly planDirectiveQueue: Queue,
    @Inject(PLAN_ITEM_REPLACE_QUEUE) private readonly planItemReplaceQueue: Queue,
    @Inject(INSTAGRAM_INSIGHTS_SYNC_QUEUE) private readonly instagramInsightsSyncQueue: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      closeDatabase(this.db),
      this.generationQueue.close(),
      this.videoGenerationQueue.close(),
      this.scheduledPostPublishQueue.close(),
      this.trendResearchQueue.close(),
      this.intelligenceResearchQueue.close(),
      this.contentEditQueue.close(),
      this.planSynthesisQueue.close(),
      this.planDirectiveQueue.close(),
      this.planItemReplaceQueue.close(),
      this.instagramInsightsSyncQueue.close(),
    ]);
  }
}
