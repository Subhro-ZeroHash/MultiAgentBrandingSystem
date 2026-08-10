import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import type { Response } from 'express';
import { eq, schema, type Database } from '@bmas/db';
import { Inject } from '@nestjs/common';
import { DATABASE, ASSET_URLS } from '../core/core.module.js';
import type { AssetUrls } from '../core/asset-urls.js';
import sharp from 'sharp';
import { loadEnv } from '../config/env.js';
import { verifyAssetLink, type AssetVariant } from './asset-proxy.js';
import { instagramCanvas, needsInstagramFit } from './instagram-image.js';

/**
 * Serves asset bytes to callers that cannot use a presigned URL — in practice
 * Instagram, which downloads the image from its own servers when publishing.
 *
 * Deliberately unauthenticated: the whole point is that a third party fetches
 * it without credentials. The signature in the query string is what stands in
 * for authentication, and it is checked before anything touches storage.
 */
@Controller('assets')
export class AssetsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ASSET_URLS) private readonly assetUrls: AssetUrls,
  ) {}

  @Get(':assetId/raw')
  async streamAsset(
    @Param('assetId') assetId: string,
    @Query('exp') exp: string | undefined,
    @Query('sig') sig: string | undefined,
    @Query('v') v: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { ENCRYPTION_KEY } = loadEnv();
    if (!ENCRYPTION_KEY) {
      throw new ForbiddenException(
        'Asset links are unavailable: ENCRYPTION_KEY is not configured.',
      );
    }

    const variant: AssetVariant = v === 'ig' ? 'ig' : 'raw';
    // Verified against the requested variant, so a link cannot be edited into
    // asking for a rendition it was not issued for.
    const verdict = verifyAssetLink(assetId, exp, sig, ENCRYPTION_KEY, variant);
    if (!verdict.ok) {
      if (verdict.reason === 'expired') {
        throw new GoneException('This asset link has expired.');
      }
      throw new ForbiddenException('Invalid asset link signature.');
    }

    const rows = await this.db
      .select({ storageKey: schema.creativeAssets.storageKey })
      .from(schema.creativeAssets)
      .where(eq(schema.creativeAssets.id, assetId))
      .limit(1);

    const storageKey = rows[0]?.storageKey;
    if (!storageKey) throw new NotFoundException('Asset not found');

    const object = await this.assetUrls.read(storageKey);

    // The link already carries its own expiry; caching past it would serve
    // bytes the signature no longer authorises.
    res.setHeader('Cache-Control', 'private, max-age=60');

    if (variant === 'ig') {
      // Buffered rather than streamed: the fit depends on the source
      // dimensions, which are only known once the metadata has been read.
      const chunks: Buffer[] = [];
      for await (const chunk of object.body) chunks.push(chunk as Buffer);
      const source = Buffer.concat(chunks);

      const { width = 0, height = 0 } = await sharp(source).metadata();
      if (!needsInstagramFit(width, height)) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(await sharp(source).jpeg({ quality: 90 }).toBuffer());
        return;
      }

      const fit = instagramCanvas(width, height);
      const rendered = await sharp(source)
        .resize(fit.imageWidth, fit.imageHeight, { fit: 'fill' })
        .extend({
          top: Math.floor((fit.canvasHeight - fit.imageHeight) / 2),
          bottom: Math.ceil((fit.canvasHeight - fit.imageHeight) / 2),
          left: Math.floor((fit.canvasWidth - fit.imageWidth) / 2),
          right: Math.ceil((fit.canvasWidth - fit.imageWidth) / 2),
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        // Instagram takes JPEG only, and flattening drops any alpha the source
        // carried, which would otherwise render as black bars.
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: 90 })
        .toBuffer();

      res.setHeader('Content-Type', 'image/jpeg');
      res.end(rendered);
      return;
    }

    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    object.body.pipe(res);
  }
}
