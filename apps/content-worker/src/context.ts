import { createAiRegistryFromEnv, type AiRegistry } from '@bmas/ai';
import { createDatabase, type Database } from '@bmas/db';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Image generation is the bottleneck; keep this near the provider's limit. */
  CONTENT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
});

export interface WorkerContext {
  db: Database;
  ai: AiRegistry;
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
    redis: {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: url.password } : {}),
    },
    concurrency: env.CONTENT_WORKER_CONCURRENCY,
  };
}
