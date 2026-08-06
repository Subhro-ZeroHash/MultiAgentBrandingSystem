import { z } from 'zod';

/**
 * A `.env` file spells "not set" as `NAME=`, which reaches us as '' — but
 * `.optional()` admits only `undefined`, so a blank line fails validation
 * instead of being ignored. For a URL that surfaces as "Invalid URL" with no
 * clue which blank caused it, and the process refuses to boot.
 */
const blankAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const optionalUrl = () => blankAsUnset(z.string().url());
const optionalText = () => blankAsUnset(z.string());

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

  ANTHROPIC_API_KEY: optionalText(),
  GOOGLE_API_KEY: optionalText(),
  FAL_KEY: optionalText(),
  /** Serves text/JSON/vision. `gemini` needs no Anthropic credential. */
  LLM_PROVIDER: z.enum(['anthropic', 'gemini', 'ollama']).default('anthropic'),
  /** Local Ollama server (development only). Defaults to localhost:11434. */
  OLLAMA_BASE_URL: optionalUrl(),
  OLLAMA_MODEL: optionalText(),

  /** Real-time web search for the Trend Research Agent. Declared here purely
   *  for startup validation and the "three places" rule (CLAUDE.md) —
   *  createAiRegistryFromEnv reads process.env directly, the same as every
   *  other provider key in this schema. */
  TAVILY_API_KEY: optionalText(),
  /** Second, independent search provider for the signal pipeline (see
   *  AiRegistry.configuredWebSearches). Optional — the pipeline runs on
   *  Tavily alone without it. */
  SERPAPI_KEY: optionalText(),
  WEB_SEARCH_PROVIDER: z.enum(['tavily', 'serpapi', 'stub']).default('tavily'),

  S3_BUCKET: z.string().default('bmas-assets'),
  S3_ENDPOINT: optionalUrl(),
  /** Host clients use to fetch assets. Differs from S3_ENDPOINT whenever the
   *  client is not on this machine — a phone cannot resolve `localhost`. */
  S3_PUBLIC_ENDPOINT: optionalUrl(),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default('bmas'),
  S3_SECRET_ACCESS_KEY: z.string().default('bmas-secret'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  ASSET_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  /** From the Instagram product in the Meta dashboard — the "Instagram app ID"
   *  and secret, which are NOT the same values as the Meta/Facebook app's. */
  INSTAGRAM_APP_ID: optionalText(),
  INSTAGRAM_APP_SECRET: optionalText(),
  ENCRYPTION_KEY: optionalText(),
  /** Must be HTTPS and match the dashboard exactly; Instagram Login rejects
   *  plain-http redirects, including on localhost. */
  INSTAGRAM_OAUTH_REDIRECT_URI: optionalUrl(),
  /** Public origin Meta can reach to download images when publishing — the same
   *  tunnel that serves the OAuth callback. Distinct from S3_PUBLIC_ENDPOINT,
   *  which only has to be reachable from the user's own phone. */
  PUBLIC_ASSET_BASE_URL: optionalUrl(),

  DEV_OWNER_ID: z.string().default('dev-user'),
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
