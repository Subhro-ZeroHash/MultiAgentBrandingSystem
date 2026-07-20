import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);

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
