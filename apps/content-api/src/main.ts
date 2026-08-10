import 'reflect-metadata';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { config as loadDotenv } from 'dotenv';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

// Populate process.env from the repo-root .env before anything reads it. Same
// approach as packages/db's migrate/seed scripts: the env lives at the root, but
// Turbo runs each task with the package directory as cwd, so dotenv's default
// cwd lookup would miss it. Resolved from this module rather than cwd so it
// works under `nest start`, `node dist/main.js`, and Turbo alike.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env'), quiet: true });

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Product reference photos arrive base64 in the JSON body, so the default
  // 100kb limit would reject any real phone photo. Bounded well above the 12 MB
  // per-image cap the upload route enforces, allowing for base64 overhead.
  app.useBodyParser('json', { limit: '20mb' });

  // NOTE: rate limiting (ThrottlerModule in AppModule) buckets by `req.ip`.
  // Express reports the socket's peer address unless `trust proxy` is set, so
  // this is correct only while clients reach the API directly — which is the
  // case today: the app talks to the LAN address, and cloudflared fronts the
  // web port rather than this one. If the API is ever put behind a proxy or
  // tunnel, set `trust proxy` to the exact hop count here, or every request
  // will arrive wearing the proxy's IP and the whole user base will share one
  // rate-limit bucket. Do not set it to `true` on a directly-reachable
  // deployment: that trusts a client-supplied X-Forwarded-For and hands
  // anyone a way around the limit.
  app.setGlobalPrefix('api');
  // No global ValidationPipe: request validation goes through ZodValidationPipe
  // per route, so the shared @bmas/shared schemas are the single source of
  // truth. Nest's ValidationPipe would pull in class-validator and give us a
  // second, divergent way to describe the same payloads.
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();

  await app.listen(env.CONTENT_API_PORT);
  new Logger('bootstrap').log(
    `content-api listening on http://localhost:${env.CONTENT_API_PORT}/api`,
  );
}

void bootstrap();
