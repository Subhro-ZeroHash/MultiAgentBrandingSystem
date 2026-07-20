import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CONTENT_API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim())),

  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  FAL_KEY: z.string().optional(),

  S3_BUCKET: z.string().default('bmas-assets'),
  S3_ENDPOINT: z.string().url().optional(),
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
    throw new Error(`Invalid environment for content-api:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
