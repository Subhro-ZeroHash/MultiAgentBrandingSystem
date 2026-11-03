import { Body, Controller, Get, Param, Post, Request, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { TemplatesService } from './templates.service.js';

const publishTemplateSchema = z.object({
  videoGenerationId: z.string().min(1).max(64),
});

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

  /**
   * Turns a finished video generation into a public library template ("Genjutsu
   *  sharing"): the opening still, camera move, scene direction and final video
   *  URL get packaged into a `video_templates` row anyone can recreate from
   *  the Templates page.
   */
  @Post('publish')
  publish(
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(publishTemplateSchema)) body: unknown,
  ) {
    const { videoGenerationId } = body as z.infer<typeof publishTemplateSchema>;
    return this.templates.publish(videoGenerationId, req.user.id);
  }
}
