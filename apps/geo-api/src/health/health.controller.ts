import { Controller, Get, Inject } from '@nestjs/common';
import type { AiRegistry } from '@bmas/ai';
import { sql, type Database } from '@bmas/db';
import { AI_REGISTRY, DATABASE } from '../core/core.module.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AI_REGISTRY) private readonly ai: AiRegistry,
  ) {}

  @Get()
  async check() {
    const database = await this.db
      .execute(sql`select 1`)
      .then(() => 'ok' as const)
      .catch(() => 'down' as const);

    return {
      service: 'geo-api',
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      // Surfaces the "which engines can we actually probe" question that would
      // otherwise only show up as empty results in a sweep.
      engines: this.ai.configuredEngines().map((client) => client.engine),
      timestamp: new Date().toISOString(),
    };
  }
}
