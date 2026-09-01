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

/** Kept byte-for-byte in step with `.env.example`. See AUTH_SECRET below. */
const PLACEHOLDER_AUTH_SECRET = 'replace-me-with-32-bytes-of-random';

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
  LLM_PROVIDER: z.enum(['anthropic', 'gemini']).default('gemini'),

  /** Video generation. Declared here purely for startup validation and the
   *  "three places" rule — createAiRegistryFromEnv reads process.env
   *  directly, same as every other provider key in this schema. */
  LTX_API_KEY: optionalText(),
  VIDEO_PROVIDER_PRIMARY: z.enum(['ltx', 'stub']).default('stub'),

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
  /** Encrypts Instagram access tokens at rest (AES-256-GCM via
   *  TokenEncryption) and signs the asset links Instagram fetches images/
   *  videos from. Required rather than optional — it used to be, and a
   *  missing key made SocialService silently store real Instagram tokens in
   *  plaintext with no warning. Same "fail at startup, not silently" pattern
   *  AUTH_SECRET already uses below. */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""),
  /** Must be HTTPS and match the dashboard exactly; Instagram Login rejects
   *  plain-http redirects, including on localhost. */
  INSTAGRAM_OAUTH_REDIRECT_URI: optionalUrl(),
  /** Public origin Meta can reach to download images when publishing — the same
   *  tunnel that serves the OAuth callback. Distinct from S3_PUBLIC_ENDPOINT,
   *  which only has to be reachable from the user's own phone. */
  PUBLIC_ASSET_BASE_URL: optionalUrl(),

  DEV_OWNER_ID: z.string().default('dev-user'),

  /** Signs and verifies JWTs issued by AuthService. No default in production —
   *  a guessable secret defeats every route the JWT guard protects.
   *
   *  The length floor alone was not enough: the placeholder shipped in
   *  `.env.example` is 34 characters, so a `.env` copied from it and never
   *  edited passed validation and signed real sessions with a value published
   *  in the repository. Anyone able to read it could mint a token for any user
   *  id. Refusing the known placeholder by name turns that from a silent hole
   *  into a startup failure that says what to do about it. */
  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET must be at least 32 characters')
    .refine((secret) => secret !== PLACEHOLDER_AUTH_SECRET, {
      message:
        'AUTH_SECRET is still the placeholder from .env.example, which is public. ' +
        'Generate a real one: openssl rand -hex 32',
    }),
  /** How long an issued access token stays valid, in `jsonwebtoken` expiresIn
   *  format. Short on purpose — a session's real lifetime now comes from its
   *  refresh token (see `core.refresh_tokens`), which is revocable; this only
   *  bounds how long a stolen access token stays useful after that. */
  AUTH_TOKEN_TTL: z.string().default('15m'),
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
