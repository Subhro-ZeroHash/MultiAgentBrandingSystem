import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, schema, type Database } from '@bmas/db';
import type { Queue } from 'bullmq';
import sharp from 'sharp';
import type { CreateBrandKitInput, CreateProductInput, UpdateBrandKitInput } from '@bmas/shared';
import {
  DATABASE,
  GENERATION_QUEUE,
  ASSET_URLS,
  OBJECT_STORE,
  SCHEDULED_POST_PUBLISH_QUEUE,
} from '../core/core.module.js';
import type { AssetUrls } from '../core/asset-urls.js';
import { productImageKey, type ObjectStore } from '../core/object-store.js';
import { BlockedAddressError } from '../brand-site/net-guard.js';
import { SocialService } from '../social/social.service.js';
import { classifyReferenceLink, fetchReferenceLink, TooBigError } from './reference-link.js';
import { AutomationSettingsService } from './automation-settings.service.js';
import { BrandContextService } from './brand-context.service.js';

/** Reference photos are conditioning input, not arbitrary uploads. Bounded so a
 *  single request cannot exhaust memory, and restricted to the types the image
 *  models accept. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** A Studio sample reel goes to Gemini inline, whose request limit is 20 MB
 *  after base64 — this keeps it under that, and under the JSON body limit. */
const MAX_VIDEO_BYTES = 14 * 1024 * 1024;
/** A linked reel is downloaded server-side, not sent as JSON, so it may be
 *  bigger; the worker shrinks anything over the inline limit before Gemini. */
const MAX_LINKED_VIDEO_BYTES = 50 * 1024 * 1024;
const REFERENCE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

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
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
    private readonly social: SocialService,
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
    // No query-param pagination here — one account's own brands, not a
    // shared or growing-without-bound collection. This cap is a defensive
    // ceiling, not a real page size.
    return this.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.ownerId, ownerId))
      .orderBy(schema.brands.createdAt)
      .limit(200);
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

  /**
   * A Studio reference: an image (look, person, place) or a sample reel. Not
   * tied to a product and kept as a bare storage key the client sends back in
   * a video request; the request schema only accepts this brand's keys.
   */
  async addReference(
    brandId: string,
    ownerId: string,
    input: { base64: string; mediaType: string },
  ): Promise<{ key: string }> {
    await this.assertBrandOwned(brandId, ownerId);

    const ext = REFERENCE_EXT[input.mediaType];
    if (!ext)
      throw new BadRequestException('Use a PNG, JPG or WEBP image, or an MP4 or MOV video.');
    const video = input.mediaType.startsWith('video/');
    const max = video ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    const tooBig = `File exceeds the maximum size (${max / 1024 / 1024} MB).`;
    if (input.base64.length > max * 1.4) throw new BadRequestException(tooBig);

    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length === 0) throw new BadRequestException('File is empty or not valid base64.');
    if (bytes.length > max) throw new BadRequestException(tooBig);

    // Proof of type, as for product photos: sharp decodes an image; MP4 and
    // MOV are both ISO-BMFF, which always carries 'ftyp' at byte 4.
    if (video) {
      if (bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
        throw new BadRequestException('The uploaded file is not a valid MP4 or MOV video.');
      }
    } else {
      try {
        const meta = await sharp(bytes, { failOn: 'none' }).metadata();
        if (!meta.width || !meta.height) throw new Error('no dimensions');
      } catch {
        throw new BadRequestException('The uploaded file is not a valid image.');
      }
    }

    // ponytail: uploads are never deleted; add a sweep of old
    // brands/*/references/ keys if storage cost ever shows up.
    const key = `brands/${brandId}/references/${crypto.randomUUID()}.${ext}`;
    await this.store.put(key, bytes, input.mediaType);
    return { key };
  }

  /**
   * Copies one of this brand's generated posters into its Studio references,
   * so "Make a video" from a result can use the poster's look. Server-side
   * because the bucket is private and sends no CORS headers to the browser.
   */
  async addReferenceFromAsset(
    brandId: string,
    ownerId: string,
    assetId: string,
  ): Promise<{ key: string; url: string }> {
    await this.assertBrandOwned(brandId, ownerId);
    const [asset] = await this.db
      .select({ storageKey: schema.creativeAssets.storageKey })
      .from(schema.creativeAssets)
      .innerJoin(schema.generationJobs, eq(schema.generationJobs.id, schema.creativeAssets.jobId))
      .where(and(eq(schema.creativeAssets.id, assetId), eq(schema.generationJobs.brandId, brandId)))
      .limit(1);
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found for brand ${brandId}`);

    const object = await this.assetUrls.read(asset.storageKey);
    const bytes = Buffer.concat(await object.body.toArray());
    const ext = asset.storageKey.split('.').pop()?.toLowerCase();
    const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const key = `brands/${brandId}/references/${crypto.randomUUID()}.${REFERENCE_EXT[mediaType]}`;
    await this.store.put(key, bytes, mediaType);
    return { key, url: await this.assetUrls.sign(key) };
  }

  /**
   * A Studio reference given as a link. A YouTube link goes to Gemini as it
   * is (or, wanted as a photo, becomes its thumbnail); an Instagram link must
   * be one of the user's own posts, fetched through their connection; any
   * other link is downloaded here, guarded against private addresses. What
   * comes back is checked to really be an image or MP4/MOV and stored like an
   * upload.
   */
  async addReferenceFromUrl(
    brandId: string,
    ownerId: string,
    rawUrl: string,
    as: 'image' | 'video' = 'video',
  ): Promise<{ kind: 'image' | 'video' | 'youtube'; key?: string; url: string }> {
    await this.assertBrandOwned(brandId, ownerId);
    const link = classifyReferenceLink(rawUrl);
    if (link.kind === 'refused') throw new BadRequestException(link.reason);

    let targets: URL[];
    if (link.kind === 'youtube') {
      if (as === 'video') return { kind: 'youtube', url: link.url };
      // Not every video has the large thumbnail; the smaller one always exists.
      const id = new URL(link.url).searchParams.get('v');
      targets = ['maxresdefault', 'hqdefault'].map(
        (size) => new URL(`https://i.ytimg.com/vi/${id}/${size}.jpg`),
      );
    } else if (link.kind === 'instagram') {
      const media = await this.social.findOwnInstagramMedia(ownerId, link.shortcode);
      if (!media) {
        throw new BadRequestException(
          "That post isn't from an Instagram account you've connected in Settings. Instagram only lets apps use your own posts: for someone else's, save it and upload the file, or use a YouTube link.",
        );
      }
      if (!media.url) {
        throw new BadRequestException(
          "Instagram doesn't share this reel's video (it may use licensed music). Save it from Instagram and upload the file instead.",
        );
      }
      targets = [new URL(media.url)];
    } else {
      targets = [link.url];
    }

    let bytes: Buffer | undefined;
    for (const [i, target] of targets.entries()) {
      try {
        bytes = await fetchReferenceLink(target, MAX_LINKED_VIDEO_BYTES);
        break;
      } catch (error) {
        if (i < targets.length - 1) continue;
        throw new BadRequestException(
          error instanceof TooBigError
            ? 'That file is over 50 MB. Use a shorter or smaller version.'
            : error instanceof BlockedAddressError
              ? "That link points somewhere we can't fetch from."
              : `We couldn't download that link${error instanceof Error ? ` (${error.message})` : ''}.`,
        );
      }
    }
    if (!bytes) throw new BadRequestException("We couldn't download that link.");

    let mediaType: string;
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
      // The ISO-BMFF major brand says which of the two it is.
      mediaType =
        bytes.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    } else {
      const meta = await sharp(bytes, { failOn: 'none' })
        .metadata()
        .catch(() => null);
      if (!meta?.width || !meta.height) {
        throw new BadRequestException(
          'That link isn\'t an image or an MP4/MOV video. For an image, right-click it and choose "Copy image address".',
        );
      }
      if (bytes.length > MAX_IMAGE_BYTES)
        throw new BadRequestException('That image is over 12 MB.');
      // GIF, AVIF, SVG and the like become a JPEG the image model takes.
      if (meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'webp') {
        mediaType = `image/${meta.format}`;
      } else {
        bytes = await sharp(bytes).jpeg({ quality: 90 }).toBuffer();
        mediaType = 'image/jpeg';
      }
    }

    const key = `brands/${brandId}/references/${crypto.randomUUID()}.${REFERENCE_EXT[mediaType]}`;
    await this.store.put(key, bytes, mediaType);
    return {
      kind: mediaType.startsWith('video/') ? 'video' : 'image',
      key,
      url: await this.assetUrls.sign(key),
    };
  }
}
