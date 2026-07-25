import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CONTENT_API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // Expo's dev server serves the web build on 8081; native builds send no
  // Origin header, so CORS does not apply to them.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:8081')
    .transform((value) => value.split(',').map((origin) => origin.trim())),

  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  FAL_KEY: z.string().optional(),
  /** Serves text/JSON/vision. `gemini` needs no Anthropic credential. */
  LLM_PROVIDER: z.enum(['anthropic', 'gemini']).default('anthropic'),

  S3_BUCKET: z.string().default('bmas-assets'),
  S3_ENDPOINT: z.string().url().optional(),
  /** Host clients use to fetch assets. Differs from S3_ENDPOINT whenever the
   *  client is not on this machine — a phone cannot resolve `localhost`. */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default('bmas'),
  S3_SECRET_ACCESS_KEY: z.string().default('bmas-secret'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  ASSET_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
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
