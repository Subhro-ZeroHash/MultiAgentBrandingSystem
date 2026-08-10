import { Controller, Get, Inject } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { sql, type Database } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';

// Polled on a fixed interval by whatever is watching the service; throttling it
// would make the monitor's own traffic look like an outage.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  async check() {
    const database = await this.db
      .execute(sql`select 1`)
      .then(() => 'ok' as const)
      .catch(() => 'down' as const);

    return {
      service: 'content-api',
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      timestamp: new Date().toISOString(),
    };
  }
}
