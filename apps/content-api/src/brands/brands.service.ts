import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, schema, type Database } from '@bmas/db';
import type { CreateBrandKitInput, CreateProductInput } from '@bmas/shared';
import { DATABASE } from '../core/core.module.js';

/**
 * The Brand Kit is shared with the GEO system (`core.brands`). Read/write it
 * here, but coordinate schema changes — see .github/CODEOWNERS.
 */
@Injectable()
export class BrandsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findOne(brandId: string) {
    const [brand] = await this.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);

    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    return brand;
  }

  async create(ownerId: string, input: CreateBrandKitInput) {
    const [brand] = await this.db
      .insert(schema.brands)
      .values({
        ownerId,
        name: input.name,
        logoUrl: input.logoUrl ?? null,
        colors: input.colors,
        toneOfVoice: input.toneOfVoice,
        category: input.category ?? null,
        audience: input.audience ?? null,
        websiteUrl: input.websiteUrl ?? null,
        socialHandles: input.socialHandles ?? {},
      })
      .returning();

    if (!brand) throw new Error('Insert returned no row');
    return brand;
  }

  async listProducts(brandId: string) {
    return this.db.select().from(schema.products).where(eq(schema.products.brandId, brandId));
  }

  async createProduct(input: CreateProductInput) {
    const [product] = await this.db
      .insert(schema.products)
      .values({
        brandId: input.brandId,
        name: input.name,
        description: input.description ?? null,
        priceMinor: input.priceMinor ?? null,
        ...(input.currency ? { currency: input.currency } : {}),
      })
      .returning();

    if (!product) throw new Error('Insert returned no row');
    return product;
  }
}
