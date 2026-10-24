import { Inject, Injectable } from '@nestjs/common';
import { desc, schema, type Database } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';

@Injectable()
export class TemplatesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  list() {
    return this.db
      .select()
      .from(schema.videoTemplates)
      .orderBy(desc(schema.videoTemplates.createdAt));
  }
}
