import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiRegistryFromEnv, type AiRegistry } from '@bmas/ai';
import { createDatabase, type Database } from '@bmas/db';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { createStorage, type Storage } from './storage.js';

// Loaded at module scope, not inside createContext: main.ts calls
// createContext() at import time, and the AI registry reads process.env too.
// See apps/content-api/src/main.ts for why the path is resolved from here.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env'), quiet: true });

/**
 * A `.env` file spells "not set" as `NAME=`, which reaches us as '' — but
 * `.optional()` admits only `undefined`, so a blank line fails `.url()`
 * validation instead of being treated as unset. Mirrors
 * apps/content-api/src/config/env.ts's `optionalUrl`.
 */
const optionalUrl = () =>
  z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Image generation is the bottleneck; keep this near the provider's limit. */
  CONTENT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** Extra rounds of image generation allowed when the QA readback fails
   *  (FR-3.5). This is the cost ceiling: worst-case spend per job is
   *  variantCount x (1 + this). 0 disables regeneration entirely — the
   *  default while there is no working provider key and every image counts;
   *  raise it back to 1 once cost is no longer the binding constraint. */
  QA_REGENERATION_ROUNDS: z.coerce.number().int().min(0).max(3).default(0),

  // Object storage for generated creatives. Defaults match the MinIO container
  // in docker-compose.yml so a local checkout works without extra setup.
  S3_ENDPOINT: optionalUrl(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().default('bmas-assets'),
  S3_ACCESS_KEY_ID: z.string().default('bmas'),
  S3_SECRET_ACCESS_KEY: z.string().default('bmas-secret'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  S3_PUBLIC_URL: optionalUrl(),

  /** Where this process reaches content-api's HTTP API. Used only by the
   *  scheduled-post publish job, which posts through the existing
   *  `/social/post` endpoint rather than duplicating the Instagram Graph API
   *  logic that already lives there. */
  CONTENT_API_URL: z.string().url().default('http://localhost:4000/api'),
  /** Same secret content-api's AuthModule signs and verifies JWTs with. The
   *  scheduled-post publish job mints a short-lived token for the post's real
   *  owner (not a fixed dev id) so the call passes content-api's JwtAuthGuard
   *  as that user, matching whatever brand/post it is publishing. */
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
});

export interface WorkerContext {
  db: Database;
  ai: AiRegistry;
  storage: Storage;
  redis: { host: string; port: number; password?: string };
  concurrency: number;
  qaRegenerationRounds: number;
  contentApiUrl: string;
  authSecret: string;
}

export function createContext(): WorkerContext {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment for content-worker:\n${issues}`);
  }

  const env = parsed.data;
  const url = new URL(env.REDIS_URL);

  return {
    db: createDatabase({ url: env.DATABASE_URL, ssl: env.NODE_ENV === 'production' }),
    ai: createAiRegistryFromEnv(),
    storage: createStorage({
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      ...(env.S3_PUBLIC_URL ? { publicUrl: env.S3_PUBLIC_URL } : {}),
    }),
    redis: {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: url.password } : {}),
    },
    concurrency: env.CONTENT_WORKER_CONCURRENCY,
    qaRegenerationRounds: env.QA_REGENERATION_ROUNDS,
    contentApiUrl: env.CONTENT_API_URL,
    authSecret: env.AUTH_SECRET,
  };
}
