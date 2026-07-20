import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { creativeRequestSchema, type CreativeRequest } from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { GenerationsService } from './generations.service.js';

@Controller('generations')
export class GenerationsController {
  constructor(private readonly generations: GenerationsService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(creativeRequestSchema)) body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return this.generations.enqueue(body as CreativeRequest, idempotencyKey);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.generations.findOne(id);
  }

  @Get()
  list(@Query('brandId') brandId: string, @Query('limit') limit = '20') {
    return this.generations.listByBrand(brandId, Number(limit));
  }
}
