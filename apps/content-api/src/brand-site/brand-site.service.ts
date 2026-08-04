import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AiRegistry } from '@bmas/ai';
import { eq, schema, type Database } from '@bmas/db';
import type {
  ApplyBrandSiteInput,
  BrandSiteProfile,
  ImportBrandSiteInput,
  SiteAnalysis,
  SiteExtraction,
  SiteProfileStatus,
} from '@bmas/shared';
import { BrandContextService } from '../brands/brand-context.service.js';
import { AI_REGISTRY, DATABASE, OBJECT_STORE } from '../core/core.module.js';
import type { ObjectStore } from '../core/object-store.js';
import { analyzeSite } from './analyze-site.js';
import { brandPalette, extractSite } from './extract-site.js';
import { fetchBrandAssets } from './fetch-brand-assets.js';
import { fetchSite, SiteUnreachableError } from './fetch-site.js';
import { BlockedAddressError } from './net-guard.js';

/**
 * Reads a brand's own website and proposes a Brand Kit from it (FR-1.4).
 *
 * Runs once at setup rather than per generation. Three reasons, in order of
 * weight: a scheduled campaign generating twenty posts would otherwise re-read
 * the site twenty times and drift visually between posts that are supposed to
 * look like one campaign; generation is already a two-minute job and this would
 * add to every run; and websites change far more slowly than they are read.
 *
 * Nothing here writes to `core.brands` on its own. The import produces a
 * proposal the user confirms, because `brands.colors` is treated as
 * authoritative by the image brief — a misread palette applied silently would
 * tint every creative the brand ever makes, with no obvious cause.
 */
@Injectable()
export class BrandSiteService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AI_REGISTRY) private readonly ai: AiRegistry,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly context: BrandContextService,
  ) {}

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ ownerId: schema.brands.ownerId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);

    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
    if (brand.ownerId !== ownerId) {
      throw new ForbiddenException('This brand belongs to another account.');
    }
  }

  /**
   * Fetches, extracts, analyses, and stores the result as an unapplied
   * proposal.
   *
   * A fetch that fails is still recorded. The row is what the review screen
   * reads, and "we tried this URL and it was unreachable" is a far better
   * answer than an empty screen — it also stops the client re-triggering an
   * expensive round trip against a site that is down.
   */
  async importFromWebsite(
    brandId: string,
    ownerId: string,
    input: ImportBrandSiteInput,
  ): Promise<BrandSiteProfile> {
    await this.assertBrandOwned(brandId, ownerId);

    let status: SiteProfileStatus = 'ok';
    let extraction: SiteExtraction | null = null;
    let analysis: SiteAnalysis | null = null;
    let error: string | null = null;
    let sourceUrl = input.url;
    let logoStorageKey: string | null = null;
    let styleReferenceKeys: string[] = [];

    try {
      const site = await fetchSite(input.url);
      sourceUrl = site.finalUrl;

      const result = extractSite({
        html: site.html,
        stylesheets: site.stylesheets,
        finalUrl: site.finalUrl,
      });
      extraction = result.extraction;

      // Runs regardless of `looksEmpty`: a client-rendered page still ships its
      // logo in the markup and its og:image in the head, so the assets survive
      // even when the copy does not.
      const assets = await fetchBrandAssets({
        brandId,
        logoUrl: extraction.logoUrl,
        imageUrls: extraction.imageUrls,
        store: this.store,
      });
      logoStorageKey = assets.logo?.storageKey ?? null;
      styleReferenceKeys = assets.styleReferences.map((asset) => asset.storageKey);

      if (result.looksEmpty) {
        // The palette and typefaces are still worth keeping — they come from
        // stylesheets, which a client-rendered site ships in full. It is the
        // copy that is missing, and with it any basis for reading a voice.
        status = 'empty_document';
        error =
          "We could read this site's colours and fonts, but its text is rendered in the browser, " +
          'so there was nothing for us to read. Fill in the tone and audience yourself, or try ' +
          'a page with more static content.';
      } else {
        const analysed = await analyzeSite(this.ai, extraction, sourceUrl, {
          brandId,
          referenceId: `site-import-${brandId}`,
        });
        analysis = analysed.analysis;

        // Every provider call records cost (CLAUDE.md rule 5). Operation is
        // named so this is separable from generation spend in the ledger —
        // it is per-brand setup, not per-creative marginal cost.
        await this.db.insert(schema.costEvents).values({
          brandId,
          system: 'content',
          referenceId: `site-import-${brandId}`,
          provider: analysed.cost.provider,
          model: analysed.cost.model,
          operation: 'site-analysis',
          inputTokens: analysed.cost.inputTokens ?? null,
          outputTokens: analysed.cost.outputTokens ?? null,
          cachedInputTokens: analysed.cost.cachedInputTokens ?? null,
          imageCount: analysed.cost.imageCount ?? null,
          costMicroUsd: analysed.cost.costMicroUsd,
          latencyMs: analysed.cost.latencyMs ?? null,
        });
      }
    } catch (caught) {
      if (caught instanceof BlockedAddressError) {
        // The caller's mistake, and the message names the fix, so it is a 400
        // rather than a stored failure.
        throw new BadRequestException(caught.message);
      }

      status = caught instanceof SiteUnreachableError ? 'unreachable' : 'failed';
      error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[brand-site] import failed for brand ${brandId} (${input.url}):`, caught);
    }

    return this.upsertProfile({
      brandId,
      sourceUrl,
      status,
      extraction,
      analysis,
      logoStorageKey,
      styleReferenceKeys,
      error,
    });
  }

  private async upsertProfile(values: {
    brandId: string;
    sourceUrl: string;
    status: SiteProfileStatus;
    extraction: SiteExtraction | null;
    analysis: SiteAnalysis | null;
    logoStorageKey: string | null;
    styleReferenceKeys: string[];
    error: string | null;
  }): Promise<BrandSiteProfile> {
    const now = new Date();

    const [row] = await this.db
      .insert(schema.brandSiteProfiles)
      .values({ ...values, fetchedAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.brandSiteProfiles.brandId,
        set: {
          sourceUrl: values.sourceUrl,
          status: values.status,
          extraction: values.extraction,
          analysis: values.analysis,
          logoStorageKey: values.logoStorageKey,
          styleReferenceKeys: values.styleReferenceKeys,
          error: values.error,
          fetchedAt: now,
          // A re-import is a new proposal and needs confirming again. Carrying
          // any of these forward would let a re-read of a redesigned site
          // silently restyle everything without anyone approving it — and in
          // the logo's case, put a newly-misidentified mark on live creatives.
          appliedAt: null,
          logoAppliedAt: null,
          styleReferencesAppliedAt: null,
          updatedAt: now,
        },
      })
      .returning();

    if (!row) throw new Error('Insert returned no row');
    return row as BrandSiteProfile;
  }

  async getProfile(brandId: string, ownerId: string): Promise<BrandSiteProfile | null> {
    await this.assertBrandOwned(brandId, ownerId);

    const [row] = await this.db
      .select()
      .from(schema.brandSiteProfiles)
      .where(eq(schema.brandSiteProfiles.brandId, brandId))
      .limit(1);

    return (row as BrandSiteProfile | undefined) ?? null;
  }

  /**
   * Writes the confirmed parts of a proposal into the Brand Kit.
   *
   * Field-by-field, and only the fields the client names: a user who has
   * already written a good audience line should not have to give it up to take
   * the palette. Omitting a field leaves the existing value alone.
   */
  async apply(
    brandId: string,
    ownerId: string,
    input: ApplyBrandSiteInput,
  ): Promise<BrandSiteProfile> {
    await this.assertBrandOwned(brandId, ownerId);

    const profile = await this.getProfile(brandId, ownerId);
    if (!profile) {
      throw new NotFoundException('No website import to apply. Run the import first.');
    }
    if (profile.status === 'unreachable' || profile.status === 'failed') {
      throw new BadRequestException(
        'That website could not be read, so there is nothing to apply. Try importing again.',
      );
    }

    const brandUpdate = {
      ...(input.colors ? { colors: input.colors } : {}),
      ...(input.tone ? { tone: input.tone } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
      ...(input.languages ? { languages: input.languages } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      // The site we actually read, after redirects — so a later refresh starts
      // from the resolved URL rather than the one that redirected.
      websiteUrl: profile.sourceUrl,
      updatedAt: new Date(),
    };

    await this.db
      .update(schema.brands)
      .set(brandUpdate)
      .where(eq(schema.brands.id, brandId));

    // Opting the logo in without one stored would leave the brief promising the
    // model an attachment that never arrives, which reads as a bug in the
    // creative rather than a missing asset.
    if (input.useLogo && !profile.logoStorageKey) {
      throw new BadRequestException(
        'No logo could be read from that website, so it cannot be used on creatives. Upload one instead.',
      );
    }
    if (input.useStyleReferences && profile.styleReferenceKeys.length === 0) {
      throw new BadRequestException(
        'No usable brand photography was found on that website, so it cannot be used as a style reference.',
      );
    }

    const now = new Date();
    const [updated] = await this.db
      .update(schema.brandSiteProfiles)
      .set({
        // Null when the user took the Brand Kit fields but not the art
        // direction; the pipeline checks these columns, so clearing them is
        // what keeps generation out of it. Three separate gates because they
        // fail differently: wrong prose looks off-brand, a wrong logo puts
        // someone else's trademark on the ad, and wrong photography invites
        // the model to reproduce a subject nobody asked for.
        appliedAt: input.useForGeneration ? now : null,
        logoAppliedAt: input.useLogo ? now : null,
        styleReferencesAppliedAt: input.useStyleReferences ? now : null,
        updatedAt: now,
      })
      .where(eq(schema.brandSiteProfiles.brandId, brandId))
      .returning();

    if (!updated) throw new Error('Update returned no row');

    // Fill the Brand Brain from the same reading. Gaps only, and skipped
    // entirely once the user has confirmed their context — see
    // `updateBrandContextFromWebsite`. Not fatal to the apply: the Brand Kit
    // write above already succeeded, and failing the request now would tell the
    // user their palette was rejected when it was not.
    if (profile.analysis) {
      await this.context
        .updateBrandContextFromWebsite(brandId, profile.analysis)
        .catch(() => undefined);
    }

    return updated as BrandSiteProfile;
  }

  /** Drops the import entirely. The Brand Kit fields it wrote stay — they are
   *  the user's values now, and silently reverting them would be a surprise. */
  async remove(brandId: string, ownerId: string): Promise<void> {
    await this.assertBrandOwned(brandId, ownerId);
    await this.db
      .delete(schema.brandSiteProfiles)
      .where(eq(schema.brandSiteProfiles.brandId, brandId));
  }

  /** Suggested palette for the review screen — the chromatic colours only,
   *  capped at what the Brand Kit holds. */
  suggestedPalette(profile: BrandSiteProfile): string[] {
    return profile.extraction ? brandPalette(profile.extraction.colors, 3) : [];
  }
}
