import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, schema, type Database } from '@bmas/db';
import type { Queue } from 'bullmq';
import sharp from 'sharp';
import type { CreateBrandKitInput, CreateProductInput, UpdateBrandKitInput } from '@bmas/shared';
import {
  DATABASE,
  GENERATION_QUEUE,
  OBJECT_STORE,
  SCHEDULED_POST_PUBLISH_QUEUE,
} from '../core/core.module.js';
import { productImageKey, type ObjectStore } from '../core/object-store.js';
import { AutomationSettingsService } from './automation-settings.service.js';
import { BrandContextService } from './brand-context.service.js';

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
  private readonly logger = new Logger(BrandsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(SCHEDULED_POST_PUBLISH_QUEUE) private readonly publishQueue: Queue,
    @Inject(GENERATION_QUEUE) private readonly generationQueue: Queue,
    private readonly context: BrandContextService,
    private readonly automation: AutomationSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Ownership
  //
  // The caller is resolved from the JWT (JwtAuthGuard -> req.user.id), and
  // every brand-scoped module (trends, scheduling, brand-site, social, and
  // now geo-api) refuses a brand that isn't theirs. These enforce it here.
  // ---------------------------------------------------------------------------

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) throw new NotFoundException(`Brand ${brandId} not found`);
  }

  /** Every brand the caller owns, oldest first so the list order is stable as
   *  brands are added — the client picks an active one from this. */
  async listForOwner(ownerId: string) {
    return this.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.ownerId, ownerId))
      .orderBy(schema.brands.createdAt);
  }

  async findOne(brandId: string, ownerId: string) {
    const [brand] = await this.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);

    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) throw new NotFoundException(`Brand ${brandId} not found`);
    return brand;
  }

  async update(brandId: string, ownerId: string, input: UpdateBrandKitInput) {
    await this.assertBrandOwned(brandId, ownerId);

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

    // Every brand owns its Brand Brain from the moment it exists: a context row
    // seeded from the kit, and automation settings defaulting to fully manual.
    // Both are idempotent, so this is also the repair path for brands created
    // before the feature landed — but doing it here means the common case never
    // takes the "missing, create it" branch on a read.
    await this.context.ensureContext(brand.id);
    await this.automation.ensureSettings(brand.id);

    return brand;
  }

  /**
   * Deletes a brand and everything filed under it.
   *
   * The row deletion itself is one statement — every child table (products,
   * generation jobs, scheduled campaigns and posts, trend research, the site
   * profile, and GEO's tracking tables) cascades from `core.brands`, and
   * `core.cost_events` deliberately nulls its brand instead so the spend
   * ledger stays complete.
   *
   * What does not cascade is queued work: BullMQ lives in Redis, so a delayed
   * publish job or a not-yet-run generation would still fire against rows that
   * no longer exist. Those are drained first, the same way cancelling a
   * campaign does it (`SchedulingService.tearDownCampaign`).
   */
  async remove(brandId: string, ownerId: string): Promise<{ id: string; name: string }> {
    const brand = await this.findOne(brandId, ownerId);

    // Every brand-scoped screen needs something to point at, and the app has
    // no "no brand selected" state to fall back to. Refusing here is kinder
    // than leaving an account that cannot generate anything.
    const owned = await this.db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(eq(schema.brands.ownerId, ownerId));
    if (owned.length <= 1) {
      throw new BadRequestException(
        'This is your only brand. Create another one before deleting this.',
      );
    }

    await this.drainQueuedWork(brandId);

    await this.db.delete(schema.brands).where(eq(schema.brands.id, brandId));
    return { id: brand.id, name: brand.name };
  }

  /**
   * Removes this brand's not-yet-run jobs from Redis.
   *
   * Best-effort per job: a job that already started, or that BullMQ has
   * cleaned up, throws on `remove()`. That is not a reason to abort the
   * delete — the worst case is one orphaned job that no-ops when it looks its
   * row up and finds nothing, which both processors already handle.
   */
  private async drainQueuedWork(brandId: string): Promise<void> {
    // Publish jobs are keyed by the scheduled post's own id (see
    // SchedulingService.enqueuePublish), so the row ids are the job ids.
    const posts = await this.db
      .select({ id: schema.scheduledPosts.id })
      .from(schema.scheduledPosts)
      .where(eq(schema.scheduledPosts.brandId, brandId));

    // Generation jobs are keyed by idempotency key, not by row id.
    const generations = await this.db
      .select({ idempotencyKey: schema.generationJobs.idempotencyKey })
      .from(schema.generationJobs)
      .where(eq(schema.generationJobs.brandId, brandId));

    const removals = [
      ...posts.map((post) => this.publishQueue.getJob(post.id)),
      ...generations.map((generation) => this.generationQueue.getJob(generation.idempotencyKey)),
    ];

    const found = await Promise.all(removals.map((p) => p.catch(() => undefined)));
    await Promise.all(found.map((job) => job?.remove().catch(() => undefined)));

    this.logger.log(
      `Draining brand ${brandId}: ${posts.length} scheduled posts, ${generations.length} generations.`,
    );
  }

  async listProducts(brandId: string, ownerId: string) {
    await this.assertBrandOwned(brandId, ownerId);
    return this.db.select().from(schema.products).where(eq(schema.products.brandId, brandId));
  }

  async createProduct(input: CreateProductInput, ownerId: string) {
    // Checked rather than left to the foreign key: a bad brandId would surface
    // as a raw constraint violation and a 500, when it is the caller's mistake.
    // Also covers ownership, since findOne now enforces it.
    await this.findOne(input.brandId, ownerId);

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
  async addProductImage(
    brandId: string,
    productId: string,
    ownerId: string,
    input: ProductImageUpload,
  ) {
    await this.assertBrandOwned(brandId, ownerId);

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
    if (!product)
      throw new NotFoundException(`Product ${productId} not found for brand ${brandId}`);

    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length === 0)
      throw new BadRequestException('Image data is empty or not valid base64.');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Image exceeds the maximum size (12 MB).');
    }

    // ALLOWED_MEDIA_TYPES above only checks the caller's claimed mediaType
    // string — sharp actually decoding the bytes is the only real proof this
    // is an image at all, same reasoning fetch-brand-assets.ts's normalise()
    // uses for fetched assets. Rejects anything else (an HTML/script payload
    // renamed to look like an image, a corrupt upload) before it's stored.
    try {
      const meta = await sharp(bytes, { failOn: 'none' }).metadata();
      if (!meta.width || !meta.height) throw new Error('no dimensions');
    } catch {
      throw new BadRequestException('The uploaded file is not a valid image.');
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
