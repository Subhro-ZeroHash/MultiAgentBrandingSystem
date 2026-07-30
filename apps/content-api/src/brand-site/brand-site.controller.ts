import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import {
  applyBrandSiteSchema,
  importBrandSiteSchema,
  type ApplyBrandSiteInput,
  type ImportBrandSiteInput,
} from '@bmas/shared';
import { getUserIdFromHeader } from '../common/user-id.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { BrandSiteService } from './brand-site.service.js';

@Controller('brands/:brandId/site-profile')
export class BrandSiteController {
  constructor(private readonly siteProfiles: BrandSiteService) {}

  /**
   * Reads the website and returns a proposal. Synchronous: the caller is a
   * person on an onboarding screen watching a spinner, and the fetcher's own
   * 20-second budget bounds how long that lasts. Nothing is written to the
   * Brand Kit until `apply`.
   */
  @Post('import')
  async import(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(importBrandSiteSchema)) body: unknown,
  ) {
    const profile = await this.siteProfiles.importFromWebsite(
      brandId,
      getUserIdFromHeader(userIdHeader),
      body as ImportBrandSiteInput,
    );

    // The palette the review screen should preselect, computed here so the
    // client does not reimplement the neutral filtering.
    return { profile, suggestedColors: this.siteProfiles.suggestedPalette(profile) };
  }

  @Get()
  async get(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
  ) {
    const profile = await this.siteProfiles.getProfile(
      brandId,
      getUserIdFromHeader(userIdHeader),
    );

    if (!profile) return { profile: null, suggestedColors: [] };
    return { profile, suggestedColors: this.siteProfiles.suggestedPalette(profile) };
  }

  @Post('apply')
  apply(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
    @Body(new ZodValidationPipe(applyBrandSiteSchema)) body: unknown,
  ) {
    return this.siteProfiles.apply(
      brandId,
      getUserIdFromHeader(userIdHeader),
      body as ApplyBrandSiteInput,
    );
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @Param('brandId') brandId: string,
    @Headers('x-user-id') userIdHeader: string | undefined,
  ) {
    await this.siteProfiles.remove(brandId, getUserIdFromHeader(userIdHeader));
  }
}
