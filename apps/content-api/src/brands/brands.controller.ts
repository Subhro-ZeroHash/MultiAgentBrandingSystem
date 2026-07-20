import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { createBrandKitSchema, createProductSchema } from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BrandsService } from './brands.service.js';

@Controller('brands')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.brands.findOne(id);
  }

  @Post()
  create(@Body(new ZodValidationPipe(createBrandKitSchema)) body: unknown) {
    // TODO(content): take the owner from the authenticated request once auth
    // lands. Until then it falls back to the user created by `pnpm db:seed`,
    // so the write path is exercisable without a fake FK target.
    const ownerId = process.env.DEV_OWNER_ID ?? 'dev-user';
    return this.brands.create(ownerId, body as Parameters<BrandsService['create']>[1]);
  }

  @Get(':id/products')
  listProducts(@Param('id') id: string) {
    return this.brands.listProducts(id);
  }

  @Post(':id/products')
  createProduct(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createProductSchema.omit({ brandId: true }))) body: unknown,
  ) {
    return this.brands.createProduct({
      ...(body as Omit<Parameters<BrandsService['createProduct']>[0], 'brandId'>),
      brandId: id,
    });
  }
}
