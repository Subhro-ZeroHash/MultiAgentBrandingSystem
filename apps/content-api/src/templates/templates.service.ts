import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, desc, eq, schema, type Database } from '@bmas/db';
import type { VideoGenerationRequest } from '@bmas/shared';
import { DATABASE, ASSET_URLS } from '../core/core.module.js';
import type { AssetUrls } from '../core/asset-urls.js';

@Injectable()
export class TemplatesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
  ) {}

  list() {
    return this.db
      .select()
      .from(schema.videoTemplates)
      .orderBy(desc(schema.videoTemplates.createdAt));
  }

  async getById(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.videoTemplates)
      .where(eq(schema.videoTemplates.id, id))
      .limit(1);

    if (!row) {
      throw new NotFoundException(`Template ${id} not found`);
    }

    return row;
  }

  /**
   * "Genjutsu" sharing: packages a finished video generation into a public
   *  library template — its opening still, camera move, scene direction and
   *  final video URL — so anyone can recreate it from the Templates page.
   */
  async publish(videoGenerationId: string, ownerId: string) {
    const [job] = await this.db
      .select()
      .from(schema.videoGenerationJobs)
      .where(eq(schema.videoGenerationJobs.id, videoGenerationId))
      .limit(1);
    if (!job) {
      throw new NotFoundException(`Video generation job ${videoGenerationId} not found`);
    }
    // Brand-scoped routes check ownership — a template exposes the brand's
    // video, so only its owner may publish it.
    const [brand] = await this.db
      .select({ name: schema.brands.name, ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, job.brandId))
      .limit(1);
    if (!brand || brand.ownerId !== ownerId) {
      throw new NotFoundException(`Video generation job ${videoGenerationId} not found`);
    }
    if (job.status !== 'succeeded') {
      throw new BadRequestException('Only a finished video can be published to the library.');
    }

    const [asset] = await this.db
      .select()
      .from(schema.videoAssets)
      .where(eq(schema.videoAssets.jobId, job.id))
      .orderBy(asc(schema.videoAssets.createdAt))
      .limit(1);
    if (!asset) {
      throw new BadRequestException('This video has no file to publish.');
    }

    const request = job.request as unknown as VideoGenerationRequest;
    const videoUrl = await this.assetUrls.sign(asset.storageKey);
    const thumbnailKey = asset.thumbnailStorageKey ?? job.frames?.[0] ?? null;
    const thumbnailUrl = thumbnailKey ? await this.assetUrls.sign(thumbnailKey) : videoUrl;
    const sceneDirection = request.prompt ?? job.brief ?? '';
    const title = `${brand.name}'s video${sceneDirection ? ` — ${sceneDirection.slice(0, 60)}` : ''}`;

    const [template] = await this.db
      .insert(schema.videoTemplates)
      .values({
        title,
        thumbnailUrl,
        referenceVideoUrl: videoUrl,
        sceneDirection,
        camera: request.camera ?? null,
        style: request.styleTemplate,
      })
      .returning();

    return template;
  }
}
