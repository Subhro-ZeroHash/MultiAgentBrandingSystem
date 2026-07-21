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

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Image generation is the bottleneck; keep this near the provider's limit. */
  CONTENT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),

  // Object storage for generated creatives. Defaults match the MinIO container
  // in docker-compose.yml so a local checkout works without extra setup.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().default('bmas-assets'),
  S3_ACCESS_KEY_ID: z.string().default('bmas'),
  S3_SECRET_ACCESS_KEY: z.string().default('bmas-secret'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  S3_PUBLIC_URL: z.string().url().optional(),
});

export interface WorkerContext {
  db: Database;
  ai: AiRegistry;
  storage: Storage;
  redis: { host: string; port: number; password?: string };
  concurrency: number;
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
    db: createDatabase({ url: env.DATABASE_URL }),
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
  };
}
