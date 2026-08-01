import { Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { createBrandKitSchema, createProductSchema, updateBrandKitSchema, type UpdateBrandKitInput } from '@bmas/shared';
import { z } from 'zod';
import { getUserIdFromHeader } from '../common/user-id.js';
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

  @Get()
  list(@Headers('x-user-id') userIdHeader: string | undefined) {
    return this.brands.listForOwner(getUserIdFromHeader(userIdHeader));
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Headers('x-user-id') userIdHeader: string | undefined) {
    return this.brands.findOne(id, getUserIdFromHeader(userIdHeader));
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(updateBrandKitSchema)) body: unknown,
  ) {
    return this.brands.update(id, getUserIdFromHeader(userIdHeader), body as UpdateBrandKitInput);
  }

  @Post()
  create(
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(createBrandKitSchema)) body: unknown,
  ) {
    return this.brands.create(
      getUserIdFromHeader(userIdHeader),
      body as Parameters<BrandsService['create']>[1],
    );
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Headers('x-user-id') userIdHeader: string | undefined) {
    return this.brands.remove(id, getUserIdFromHeader(userIdHeader));
  }

  @Get(':id/products')
  listProducts(@Param('id') id: string, @Headers('x-user-id') userIdHeader: string | undefined) {
    return this.brands.listProducts(id, getUserIdFromHeader(userIdHeader));
  }

  @Post(':id/products')
  createProduct(
    @Param('id') id: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(createProductSchema.omit({ brandId: true }))) body: unknown,
  ) {
    return this.brands.createProduct(
      {
        ...(body as Omit<Parameters<BrandsService['createProduct']>[0], 'brandId'>),
        brandId: id,
      },
      getUserIdFromHeader(userIdHeader),
    );
  }

  @Post(':id/products/:productId/images')
  addProductImage(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(productImageUploadSchema)) body: unknown,
  ) {
    return this.brands.addProductImage(
      id,
      productId,
      getUserIdFromHeader(userIdHeader),
      body as ProductImageUploadInput,
    );
  }
}
