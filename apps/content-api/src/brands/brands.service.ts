import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, schema, type Database } from '@bmas/db';
import type { CreateBrandKitInput, CreateProductInput, UpdateBrandKitInput } from '@bmas/shared';
import { DATABASE, OBJECT_STORE } from '../core/core.module.js';
import { productImageKey, type ObjectStore } from '../core/object-store.js';

/** Reference photos are conditioning input, not arbitrary uploads. Bounded so a
 *  single request cannot exhaust memory, and restricted to the types the image
 *  models accept. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export interface ProductImageUpload {
  base64: string;
  mediaType: string;
  isPrimary?: boolean;
  width?: number;
  height?: number;
}

/**
 * The Brand Kit is shared with the GEO system (`core.brands`). Read/write it
 * here, but coordinate schema changes — see .github/CODEOWNERS.
 */
@Injectable()
export class BrandsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async findOne(brandId: string) {
    const [brand] = await this.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);

    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    return brand;
  }

  async update(brandId: string, input: UpdateBrandKitInput) {
    const [updated] = await this.db
      .update(schema.brands)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
        ...(input.colors ? { colors: input.colors } : {}),
        ...(input.tone ? { tone: input.tone } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.audience !== undefined ? { audience: input.audience } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.languages ? { languages: input.languages } : {}),
        ...(input.platforms ? { platforms: input.platforms } : {}),
        ...(input.bannedTopics ? { bannedTopics: input.bannedTopics } : {}),
        ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
        ...(input.socialHandles ? { socialHandles: input.socialHandles } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.brands.id, brandId))
      .returning();

    if (!updated) throw new NotFoundException(`Brand ${brandId} not found`);
    return updated;
  }

  async create(ownerId: string, input: CreateBrandKitInput) {
    const [brand] = await this.db
      .insert(schema.brands)
      .values({
        ownerId,
        name: input.name,
        logoUrl: input.logoUrl ?? null,
        colors: input.colors,
        tone: input.tone,
        category: input.category ?? null,
        audience: input.audience ?? null,
        location: input.location ?? null,
        languages: input.languages,
        platforms: input.platforms,
        bannedTopics: input.bannedTopics,
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
    // Checked rather than left to the foreign key: a bad brandId would surface
    // as a raw constraint violation and a 500, when it is the caller's mistake.
    await this.findOne(input.brandId);

    const [product] = await this.db
      .insert(schema.products)
      .values({
        brandId: input.brandId,
        name: input.name,
        description: input.description ?? null,
        priceMinor: input.priceMinor ?? null,
        sellingPoints: input.sellingPoints,
        ...(input.currency ? { currency: input.currency } : {}),
      })
      .returning();

    if (!product) throw new Error('Insert returned no row');
    return product;
  }

  /**
   * Stores a product reference photo (FR-3.1) and records it in
   * content.product_images. The image stage loads these rows and passes the
   * bytes to the image model as visual conditioning, so an uploaded photo needs
   * no further wiring to reach generation.
   *
   * TODO(content): the asset-prep step (FR-3.6) that background-removes the
   * photo into cleanedStorageKey is not built; the raw upload is used as-is.
   */
  async addProductImage(brandId: string, productId: string, input: ProductImageUpload) {
    if (!ALLOWED_MEDIA_TYPES.has(input.mediaType)) {
      throw new BadRequestException(
        `Unsupported image type "${input.mediaType}". Use png, jpeg, or webp.`,
      );
    }

    // Reject before decoding the whole payload: base64 is ~4/3 the raw size, so
    // this bounds the buffer we are about to allocate.
    if (input.base64.length > MAX_IMAGE_BYTES * 1.4) {
      throw new BadRequestException('Image exceeds the maximum size (12 MB).');
    }

    // Confirm the product exists and belongs to the brand, so an upload cannot
    // attach to another brand's product or a missing one.
    const [product] = await this.db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.id, productId), eq(schema.products.brandId, brandId)))
      .limit(1);
    if (!product) throw new NotFoundException(`Product ${productId} not found for brand ${brandId}`);

    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length === 0) throw new BadRequestException('Image data is empty or not valid base64.');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image exceeds the maximum size (12 MB).');
    }

    const id = crypto.randomUUID();
    const storageKey = productImageKey(brandId, productId, id, input.mediaType);
    await this.store.put(storageKey, bytes, input.mediaType);

    const [row] = await this.db
      .insert(schema.productImages)
      .values({
        id,
        productId,
        storageKey,
        width: input.width ?? null,
        height: input.height ?? null,
        isPrimary: input.isPrimary ?? false,
      })
      .returning();

    if (!row) throw new Error('Insert returned no row');
    return row;
  }
}
