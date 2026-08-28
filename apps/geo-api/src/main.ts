import 'reflect-metadata';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as loadDotenv } from 'dotenv';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

// The .env lives at the repo root, but Turbo runs each task with the package
// directory as cwd, so dotenv's default lookup would miss it. Resolved from this
// module rather than cwd so it works under `nest start`, `node dist/main.js`,
// and Turbo alike. Mirrors apps/content-api/src/main.ts.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, '../../../.env'), quiet: true });

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);

  // Same reasoning as content-api/src/main.ts: a pure JSON API serves no
  // HTML, so CSP is locked all the way down rather than tuned for a page
  // that shouldn't exist.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } } }));

  app.setGlobalPrefix('api');
  // No global ValidationPipe: request validation goes through ZodValidationPipe
  // per route, so the shared @bmas/shared schemas are the single source of
  // truth. Nest's ValidationPipe would pull in class-validator and give us a
  // second, divergent way to describe the same payloads.
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();

  await app.listen(env.GEO_API_PORT);
  new Logger('bootstrap').log(`geo-api listening on http://localhost:${env.GEO_API_PORT}/api`);
}

void bootstrap();
