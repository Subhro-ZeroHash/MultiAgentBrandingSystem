import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { createBrandKitSchema, createProductSchema, updateBrandKitSchema, type UpdateBrandKitInput } from '@bmas/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BrandsService } from './brands.service.js';

/** Upload contract for a product reference photo. Kept local to content-api
 *  rather than in @bmas/shared: it is an intake shape, not a cross-workstream
 *  entity, and the GEO side never sends one. */
const productImageUploadSchema = z.object({
  base64: z.string().min(1),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  isPrimary: z.boolean().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
type ProductImageUploadInput = z.infer<typeof productImageUploadSchema>;

@Controller('brands')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.brands.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateBrandKitSchema)) body: unknown,
  ) {
    return this.brands.update(id, body as UpdateBrandKitInput);
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

  @Post(':id/products/:productId/images')
  addProductImage(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body(new ZodValidationPipe(productImageUploadSchema)) body: unknown,
  ) {
    return this.brands.addProductImage(id, productId, body as ProductImageUploadInput);
  }
}
