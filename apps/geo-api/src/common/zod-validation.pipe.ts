import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Bridges the shared Zod contracts into Nest's pipe system, so request
 * validation and the client-side types come from one definition.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
