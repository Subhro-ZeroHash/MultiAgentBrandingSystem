import { Controller, Get, Param, Query, Res, NotFoundException, ForbiddenException, GoneException } from '@nestjs/common';
import type { Response } from 'express';
import { eq, schema, type Database } from '@bmas/db';
import { Inject } from '@nestjs/common';
import { DATABASE, ASSET_URLS } from '../core/core.module.js';
import type { AssetUrls } from '../core/asset-urls.js';
import { loadEnv } from '../config/env.js';
import { verifyAssetLink } from './asset-proxy.js';

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
    @Res() res: Response,
  ): Promise<void> {
    const { ENCRYPTION_KEY } = loadEnv();
    if (!ENCRYPTION_KEY) {
      throw new ForbiddenException('Asset links are unavailable: ENCRYPTION_KEY is not configured.');
    }

    const verdict = verifyAssetLink(assetId, exp, sig, ENCRYPTION_KEY);
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

    res.setHeader('Content-Type', object.contentType);
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', String(object.contentLength));
    }
    // The link already carries its own expiry; caching past it would serve
    // bytes the signature no longer authorises.
    res.setHeader('Cache-Control', 'private, max-age=60');

    object.body.pipe(res);
  }
}
