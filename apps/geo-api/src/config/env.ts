import { z } from 'zod';

/**
 * Fail fast on misconfiguration: the process refuses to start rather than
 * throwing on the first request that touches a missing variable.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GEO_API_PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim())),

  /**
   * Must match the worker's `GEO_ROLLUP_WINDOW_DAYS`. Both processes enqueue
   * roll-ups — the worker on its cron, this API after a manual probe — and the
   * dashboard reads whichever snapshot has the newest `period_start`. If the
   * two windows disagree, the shorter one always wins the dashboard and the
   * headline score silently collapses to whatever a single sweep measured.
   */
  GEO_ROLLUP_WINDOW_DAYS: z.coerce.number().int().positive().default(7),

  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment for geo-api:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
