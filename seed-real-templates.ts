#!/usr/bin/env tsx
/**
 * Seed the Genjutsu Library with real video generations.
 *
 * Replaces the mock `video_templates` rows with videos rendered through our
 * own pipeline, then publishes each finished job to the `video_templates`
 * table using the same logic as TemplatesService.publish().
 *
 * Recipes use `videoMode: 'higgsfield_story'`, which exercises the new
 * Soul Mode (`styleReferenceUrl`) and End Frame (`lastFrameUrl`) fields
 * added across the shared schema, AI request type, Higgsfield adapter,
 * worker pipeline, and Studio UI.
 *
 * Jobs are enqueued via VideoGenerationsService.enqueue() (which calls the
 * private insertAndQueue()). Because the HIGGSFIELD_API_KEY in .env is
 * rejected by the Higgsfield API (401 Invalid credentials), jobs are
 * processed with the stub video adapter so the library still gets
 * populated end-to-end through our pipeline. When a valid Higgsfield key
 * is configured, the same enqueue path routes through the Higgsfield
 * adapter automatically via PROVIDER_FOR_MODE['higgsfield_story'] = 'higgsfield'.
 *
 * Prerequisites:
 *   - pnpm db:seed has been run (dev-brand, dev-user, dev-product-saree exist)
 *   - Docker infra is up (Postgres, Redis, MinIO)
 *
 * Usage:
 *   tsx seed-real-templates.ts
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { eq, inArray } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '.env'), quiet: true });

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const AUTH_SECRET = process.env.AUTH_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
if (!REDIS_URL) throw new Error('REDIS_URL is not set');
if (!AUTH_SECRET) throw new Error('AUTH_SECRET is not set');
if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is not set');

const DEV_USER_ID = 'dev-user';
const DEV_BRAND_ID = 'dev-brand';
const DEV_PRODUCT_ID = 'dev-product-saree';

const POLL_INTERVAL_MS = 3_000;
const JOB_TIMEOUT_MS = 10 * 60_000;

// ── Imports (relative paths; @bmas/* workspace packages don't resolve from
// the monorepo root under plain tsx) ───────────────────────────────────────

import { createDatabase, type Database, closeDatabase } from './packages/db/dist/index.js';
import * as schema from './packages/db/dist/schema/index.js';
import { createAiRegistryFromEnv } from './packages/ai/dist/index.js';
import { StubVideoAdapter } from './packages/ai/dist/adapters/stub.video.js';
import { createAssetUrls, type AssetUrls } from './apps/content-api/dist/core/asset-urls.js';
import { createStorage, type Storage } from './apps/content-worker/dist/storage.js';
import { VideoGenerationsService } from './apps/content-api/dist/video-generations/video-generations.service.js';
import { Queue } from 'bullmq';
import { QUEUES } from './packages/shared/dist/queues.js';
import {
  videoGenerationRequestSchema,
  type VideoGenerationRequest,
} from './packages/shared/dist/content/video.js';

// ── Recipe definitions ─────────────────────────────────────────────────────

interface Recipe {
  id: string;
  title: string;
  prompt: string;
  campaignType: 'generic' | 'offer' | 'launch' | 'festival';
  styleTemplate: string;
  camera: string | null;
  styleReferenceUrl: string | null;
  lastFrameUrl: string | null;
}

const STYLE_REFERENCE_URL =
  'https://images.pexels.com/photos/3965545/pexels-photo-3965545.jpeg?auto=compress&cs=tinysrgb&w=800';
const LAST_FRAME_URL =
  'https://images.pexels.com/photos/5632402/pexels-photo-5632402.jpeg?auto=compress&cs=tinysrgb&w=800';

const RECIPES: Recipe[] = [
  {
    id: 'tpl-real-cinematic-reveal',
    title: 'Cinematic Product Reveal',
    prompt:
      '@product emerges from soft shadow into a single rim light, slow cinematic reveal, premium materials catching the light, shallow depth of field.',
    campaignType: 'launch',
    styleTemplate: 'minimal_luxury',
    camera: 'push_in',
    styleReferenceUrl: STYLE_REFERENCE_URL,
    lastFrameUrl: LAST_FRAME_URL,
  },
  {
    id: 'tpl-real-lifestyle-pan',
    title: 'Fast-paced Lifestyle Pan',
    prompt:
      '@product in real-world use, natural daylight, candid moment, smooth pan following the product through a bright, airy setting.',
    campaignType: 'generic',
    styleTemplate: 'lifestyle_in_use',
    camera: 'pan',
    styleReferenceUrl: STYLE_REFERENCE_URL,
    lastFrameUrl: LAST_FRAME_URL,
  },
  {
    id: 'tpl-real-studio-orbit',
    title: 'Minimalist Studio Orbit',
    prompt:
      '@product on seamless white studio surface, soft natural shadow falloff, slow 360-degree orbit, pristine clarity, no props.',
    campaignType: 'generic',
    styleTemplate: 'studio_white',
    camera: 'orbit',
    styleReferenceUrl: STYLE_REFERENCE_URL,
    lastFrameUrl: LAST_FRAME_URL,
  },
  {
    id: 'tpl-real-festive-crane',
    title: 'Festive Celebration Crane',
    prompt:
      '@product at the centre of a festive setup — marigolds, warm jewel tones, celebratory mood, slow crane-up reveal.',
    campaignType: 'festival',
    styleTemplate: 'festive',
    camera: 'crane_up',
    styleReferenceUrl: STYLE_REFERENCE_URL,
    lastFrameUrl: LAST_FRAME_URL,
  },
  {
    id: 'tpl-real-tech-pullout',
    title: 'Tech Dark Pull-out',
    prompt:
      '@product emerging from darkness with crisp rim light, dark navy gradient background, electronic ambient feel, slow pull-back revealing the setting.',
    campaignType: 'launch',
    styleTemplate: 'tech_dark_gradient',
    camera: 'pull_out',
    styleReferenceUrl: STYLE_REFERENCE_URL,
    lastFrameUrl: LAST_FRAME_URL,
  },
  {
    id: 'tpl-real-outdoor-natural',
    title: 'Outdoor Natural Flow',
    prompt:
      '@product photographed outdoors in dappled natural light, surrounded by fresh greenery, airy and fresh mood, gentle handheld movement.',
    campaignType: 'generic',
    styleTemplate: 'outdoor_natural_light',
    camera: 'handheld',
    styleReferenceUrl: STYLE_REFERENCE_URL,
    lastFrameUrl: LAST_FRAME_URL,
  },
  {
    id: 'tpl-real-bold-sale',
    title: 'High-Energy Flash Sale',
    prompt:
      '@product bursting into frame through bright geometric shapes and typography, vibrant contrast, fast-paced retail urgency, energetic push-in.',
    campaignType: 'offer',
    styleTemplate: 'bold_discount',
    camera: 'push_in',
    styleReferenceUrl: STYLE_REFERENCE_URL,
    lastFrameUrl: LAST_FRAME_URL,
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

const redisUrl = new URL(REDIS_URL);
const redisConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJob(
  db: Database,
  jobId: string,
  label: string,
): Promise<typeof schema.videoGenerationJobs.$inferSelect> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(schema.videoGenerationJobs)
      .where(eq(schema.videoGenerationJobs.id, jobId))
      .limit(1);
    if (!row) throw new Error(`Job ${jobId} disappeared from database`);
    if (row.status === 'succeeded') return row;
    if (row.status === 'failed') {
      throw new Error(`Job ${jobId} (${label}) failed: ${row.error ?? 'no details'}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Job ${jobId} (${label}) timed out after ${JOB_TIMEOUT_MS / 1000}s`);
}

async function publishToLibrary({
  db,
  assetUrls,
  jobId,
  ownerId,
}: {
  db: Database;
  assetUrls: AssetUrls;
  jobId: string;
  ownerId: string;
}) {
  const [job] = await db
    .select()
    .from(schema.videoGenerationJobs)
    .where(eq(schema.videoGenerationJobs.id, jobId))
    .limit(1);
  if (!job) throw new Error(`Video generation job ${jobId} not found`);

  const [brand] = await db
    .select({ name: schema.brands.name, ownerId: schema.brands.ownerId })
    .from(schema.brands)
    .where(eq(schema.brands.id, job.brandId))
    .limit(1);
  if (!brand || brand.ownerId !== ownerId) {
    throw new Error(`Brand ${job.brandId} not found or not owned by ${ownerId}`);
  }
  if (job.status !== 'succeeded') {
    throw new Error(`Job ${jobId} is not succeeded (status: ${job.status})`);
  }

  const [asset] = await db
    .select()
    .from(schema.videoAssets)
    .where(eq(schema.videoAssets.jobId, job.id))
    .orderBy(schema.videoAssets.createdAt)
    .limit(1);
  if (!asset) {
    throw new Error(`Job ${jobId} has no video file to publish`);
  }

  const request = job.request as unknown as VideoGenerationRequest;
  const videoUrl = await assetUrls.sign(asset.storageKey);
  const thumbnailKey = asset.thumbnailStorageKey ?? (job.frames as string[] | null)?.[0] ?? null;
  const thumbnailUrl = thumbnailKey ? await assetUrls.sign(thumbnailKey) : videoUrl;
  const sceneDirection = request.prompt ?? (job.brief as string | null) ?? '';
  const title = `${brand.name}'s video${sceneDirection ? ` — ${sceneDirection.slice(0, 60)}` : ''}`;

  const [template] = await db
    .insert(schema.videoTemplates)
    .values({
      title,
      thumbnailUrl: thumbnailUrl,
      referenceVideoUrl: videoUrl,
      sceneDirection,
      camera: request.camera ?? null,
      style: request.styleTemplate,
    })
    .returning();

  console.warn(
    `[seed] published template "${template.title}" (id=${template.id}) from job ${jobId}`,
  );
  return template;
}

/** Process a queued video job directly with StubVideoAdapter, bypassing
 * BullMQ (whose worker dist build predates the styleReferenceUrl/lastFrameUrl
 * changes). Mirrors what runVideoGeneration + renderOne do for the
 * higgsfield_story path, but uses the stub adapter. */
async function processJob({
  db,
  storage,
  stub,
  jobId,
}: {
  db: Database;
  storage: Storage;
  stub: StubVideoAdapter;
  jobId: string;
}): Promise<void> {
  const [jobRow] = await db
    .select()
    .from(schema.videoGenerationJobs)
    .where(eq(schema.videoGenerationJobs.id, jobId))
    .limit(1);
  if (!jobRow) throw new Error(`Job ${jobId} not found`);
  if (jobRow.status !== 'queued' && jobRow.status !== 'running') return;

  const request = jobRow.request as unknown as VideoGenerationRequest;

  await db
    .update(schema.videoGenerationJobs)
    .set({ status: 'running', stage: 'generate', startedAt: new Date() })
    .where(eq(schema.videoGenerationJobs.id, jobId));

  try {
    const result = await stub.generate(request, {
      referenceId: jobId,
      brandId: jobRow.brandId,
    });

    const key = `brands/${jobRow.brandId}/videos/${jobId}/video-1.mp4`;
    await storage.put(key, result.value.data, 'video/mp4');

    await db.insert(schema.videoAssets).values({
      jobId,
      storageKey: key,
      thumbnailStorageKey: null,
      width: result.value.width,
      height: result.value.height,
      durationSeconds: result.value.durationSeconds,
      provider: result.cost.provider,
      model: result.value.model,
    });

    await db
      .update(schema.videoGenerationJobs)
      .set({ status: 'succeeded', stage: null, error: null, finishedAt: new Date() })
      .where(eq(schema.videoGenerationJobs.id, jobId));

    console.warn(`[seed] job ${jobId} rendered via stub`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(schema.videoGenerationJobs)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(schema.videoGenerationJobs.id, jobId));
    throw error;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.warn('[seed] starting — loading DI container');

  const db: Database = createDatabase({
    url: DATABASE_URL,
    ssl: false,
    max: 4,
  });

  const ai = createAiRegistryFromEnv();
  const stub = new StubVideoAdapter();
  console.warn(
    `[seed] LLM provider: ${ai.llm().provider} (video: stub — Higgsfield key invalid in .env)`,
  );

  const storage: Storage = createStorage({
    region: process.env.S3_REGION ?? 'auto',
    bucket: process.env.S3_BUCKET ?? 'bmas-assets',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'bmas',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'bmas-secret',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    ...(process.env.S3_PUBLIC_URL ? { publicUrl: process.env.S3_PUBLIC_URL } : {}),
  });

  const assetUrls: AssetUrls = createAssetUrls({
    region: process.env.S3_REGION ?? 'auto',
    bucket: process.env.S3_BUCKET ?? 'bmas-assets',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'bmas',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'bmas-secret',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    expiresInSeconds: Number(process.env.ASSET_URL_TTL_SECONDS ?? 3600),
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    ...(process.env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: process.env.S3_PUBLIC_ENDPOINT } : {}),
  });

  try {
    await storage.ensureBucket();
  } catch (error) {
    console.warn(`[seed] storage ensureBucket non-fatal: ${error}`);
  }

  // ── Dev brand / user / product (idempotent, mirrors db:seed) ──────────
  await db
    .insert(schema.users)
    .values({
      id: DEV_USER_ID,
      email: 'dev@example.com',
      name: 'Dev User',
      emailVerified: true,
    })
    .onConflictDoNothing();

  await db
    .insert(schema.brands)
    .values({
      id: DEV_BRAND_ID,
      ownerId: DEV_USER_ID,
      name: 'Dev Brand',
      colors: ['#7C2D12', '#F59E0B'],
      tone: ['elegant', 'traditional', 'premium'],
      category: 'General Retail',
      audience: 'Quality conscious customers',
      location: 'Jaipur',
      languages: ['Hindi', 'English'],
      platforms: ['Instagram', 'Facebook'],
      bannedTopics: [],
      websiteUrl: 'https://example.com',
      socialHandles: { instagram: '@mybrand' },
      videoGenerationsCount: 0,
      videoGenerationsCountDate: new Date(),
    })
    .onConflictDoNothing();

  await db
    .insert(schema.products)
    .values({
      id: DEV_PRODUCT_ID,
      brandId: DEV_BRAND_ID,
      name: 'Banarasi Silk Saree',
      description: 'Handwoven Banarasi silk saree with gold zari border.',
      priceMinor: 64900,
      currency: 'INR',
      sellingPoints: ['Pure silk', 'Handwoven', 'Traditional Banarasi design'],
    })
    .onConflictDoNothing();

  // ── Clear all existing template rows (mock + prior seed runs) ────────
  // video_templates is global (no brand FK), so wipe everything before
  // re-seeding with real pipeline output.
  await db.delete(schema.videoTemplates);
  const priorJobs = await db
    .select({ id: schema.videoGenerationJobs.id })
    .from(schema.videoGenerationJobs)
    .where(eq(schema.videoGenerationJobs.brandId, DEV_BRAND_ID));
  if (priorJobs.length > 0) {
    await db.delete(schema.videoAssets).where(
      inArray(
        schema.videoAssets.jobId,
        priorJobs.map((j) => j.id),
      ),
    );
  }
  await db
    .delete(schema.videoGenerationJobs)
    .where(eq(schema.videoGenerationJobs.brandId, DEV_BRAND_ID));
  console.warn('[seed] cleared mock video_templates rows and prior video jobs/assets');

  // ── Set up BullMQ queue (for enqueue → insertAndQueue) ────────────────
  const queue = new Queue(QUEUES.videoGeneration, { connection: redisConnection });

  // ── Instantiate VideoGenerationsService (enqueue → insertAndQueue) ────
  const videoGenService = new VideoGenerationsService(db, queue, assetUrls);

  // ── Enqueue recipes ────────────────────────────────────────────────────
  const jobIds: string[] = [];

  for (const recipe of RECIPES) {
    // Reset the daily video slot so each enqueue succeeds (seed bypasses the 2/day cap).
    await db
      .update(schema.brands)
      .set({ videoGenerationsCount: 0, videoGenerationsCountDate: new Date() })
      .where(eq(schema.brands.id, DEV_BRAND_ID));

    const request: VideoGenerationRequest = {
      brandId: DEV_BRAND_ID,
      productId: DEV_PRODUCT_ID,
      campaignType: recipe.campaignType,
      styleTemplate: recipe.styleTemplate,
      videoMode: 'higgsfield_story',
      prompt: recipe.prompt,
      camera: recipe.camera,
      width: 1080,
      height: 1920,
      durationSeconds: 10,
      ...(recipe.styleReferenceUrl ? { styleReferenceUrl: recipe.styleReferenceUrl } : {}),
      ...(recipe.lastFrameUrl ? { lastFrameUrl: recipe.lastFrameUrl } : {}),
    };

    videoGenerationRequestSchema.parse(request);

    const job = await videoGenService.enqueue(request, `seed-${recipe.id}`, DEV_USER_ID);
    jobIds.push(job.id);
    console.warn(
      `[seed] enqueued "${recipe.title}" → job ${job.id} (idempotency-key seed-${recipe.id})`,
    );
  }

  await queue.close();

  // ── Process enqueued jobs directly with StubVideoAdapter ──────────────
  console.warn(`[seed] processing ${jobIds.length} jobs via stub adapter`);
  for (const jobId of jobIds) {
    await processJob({ db, storage, stub, jobId });
  }

  // ── Wait for all jobs to complete ─────────────────────────────────────
  const completedJobs: Array<{ id: string; title: string }> = [];
  for (const [i, jobId] of jobIds.entries()) {
    const row = await waitForJob(db, jobId, RECIPES[i]!.title);
    completedJobs.push({ id: row.id, title: RECIPES[i]!.title });
    console.warn(`[seed] job ${jobId} succeeded`);
  }

  // ── Publish completed videos to video_templates ────────────────────────
  console.warn(`[seed] publishing ${completedJobs.length} templates to the library`);
  for (const job of completedJobs) {
    await publishToLibrary({ db, assetUrls, jobId: job.id, ownerId: DEV_USER_ID });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────
  await closeDatabase(db);

  console.warn(
    `[seed] done — Genjutsu Library seeded with ${completedJobs.length} video templates`,
  );
}

void main().catch((error) => {
  console.error('[seed] fatal:', error);
  process.exit(1);
});
