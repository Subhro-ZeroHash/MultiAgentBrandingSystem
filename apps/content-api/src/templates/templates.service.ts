import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, schema, type Database } from '@bmas/db';
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

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.videoTemplates)
      .where(eq(schema.videoTemplates.id, id))
      .limit(1);

    if (!row) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    return row;
  }
}

