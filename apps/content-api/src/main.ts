import 'reflect-metadata';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { config as loadDotenv } from 'dotenv';
import helmet from 'helmet';
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

  // Every response here is JSON, never HTML the API intends to serve — CSP
  // is locked all the way down rather than tuned for a page that shouldn't
  // exist. helmet's other default headers (nosniff, HSTS, etc.) come free.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } }));

  // Product reference photos arrive base64 in the JSON body, so the default
  // 100kb limit would reject any real phone photo. Bounded well above the 12 MB
  // per-image cap the upload route enforces, allowing for base64 overhead.
  app.useBodyParser('json', { limit: '20mb' });

  // NOTE: rate limiting (ThrottlerModule in AppModule) buckets by `req.ip`.
  // Express reports the socket's peer address unless `trust proxy` is set, so
  // this is correct only while clients reach the API directly. In production
  // the API sits behind nginx on the same box (see docs on deployment), which
  // is exactly one hop, so `1` is the count that keeps `req.ip` reading the
  // real client address. Do not set it to `true`: that trusts a
  // client-supplied X-Forwarded-For with unlimited hops and hands anyone a
  // way around the limit.
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);
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
