import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { TemplatesService } from './templates.service.js';

@UseGuards(JwtAuthGuard)
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  /** Returns the full list of curated video templates.
   *  Requires a valid JWT — same guard convention as every other API route. */
  @Get()
  list() {
    return this.templates.list();
  }

  /** Returns a single video template by its id. */
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.templates.getById(id);
  }
}

