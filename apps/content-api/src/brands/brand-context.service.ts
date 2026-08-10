import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  getContentContext,
  getTrendContext,
  inArray,
  isNotNull,
  schema,
  type Database,
} from '@bmas/db';
import {
  contextCompleteness,
  type AgentType,
  type BrandContext,
  type BrandContextSummary,
  type FullBrandContext,
  type SiteAnalysis,
  type UpdateBrandContextInput,
} from '@bmas/shared';
import { DATABASE } from '../core/core.module.js';
import { AutomationSettingsService } from './automation-settings.service.js';
import { BrandPreferencesService } from './brand-preferences.service.js';

/**
 * The Brand Brain's read side.
 *
 * Everything the platform knows about a brand lives across five tables — the
 * Brand Kit in `core.brands`, the website reading, the product catalogue, the
 * stated context, and the learned preferences. Every agent needs some subset of
 * that, and before this service each one assembled its own, which is how two
 * agents end up disagreeing about what a brand sells.
 *
 * One assembler, two shapes out:
 *   - `buildFullBrandContext` — everything, for the Brand Brain screen.
 *   - `getContextForAgent`    — a projection, for a prompt. Deliberately
 *                               narrow: an unused field is prompt budget spent
 *                               on nothing, and a model handed the colour
 *                               palette while researching trends will find a
 *                               way to mention it.
 */
@Injectable()
export class BrandContextService {
  private readonly logger = new Logger(BrandContextService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly preferences: BrandPreferencesService,
    private readonly automation: AutomationSettingsService,
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
   * Guarantees the brand has a context row.
   *
   * Called on brand creation, and again on every read — a brand created before
   * this feature existed has no row, and returning null for those would push
   * the same "if it is missing, make one" branch into every caller. The insert
   * is a no-op when the row exists (unique on brand_id), so concurrent first
   * reads settle on one row rather than racing.
   */
  async ensureContext(brandId: string): Promise<BrandContext> {
    const existing = await this.getContext(brandId);
    if (existing) return existing;

    // Seed from the Brand Kit rather than leaving blanks: location and audience
    // are already there, and an empty Brand Brain screen on a brand that has
    // answered these questions once reads as data loss.
    const [brand] = await this.db
      .select({ location: schema.brands.location, audience: schema.brands.audience, category: schema.brands.category })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);

    await this.db
      .insert(schema.brandContexts)
      .values({
        brandId,
        industry: brand.category,
        location: brand.location,
        audience: brand.audience,
        source: 'manual',
      })
      .onConflictDoNothing({ target: schema.brandContexts.brandId });

    const created = await this.getContext(brandId);
    if (!created) throw new Error(`Failed to create brand context for ${brandId}`);
    return created;
  }

  private async getContext(brandId: string): Promise<BrandContext | null> {
    const [row] = await this.db
      .select()
      .from(schema.brandContexts)
      .where(eq(schema.brandContexts.brandId, brandId))
      .limit(1);
    return (row as BrandContext | undefined) ?? null;
  }

  /**
   * Every brand on the account with its context condensed to a card's worth.
   *
   * Batched rather than looping `buildFullBrandContext` per brand: that would
   * be six queries times the brand count, for a screen that only renders
   * headline fields and counts. This is a fixed six regardless of how many
   * brands the account holds.
   *
   * Self-healing the same way the single-brand read is — brands predating the
   * feature have no context row — but as one multi-row insert rather than one
   * per brand.
   */
  async listContextSummaries(ownerId: string): Promise<BrandContextSummary[]> {
    const brands = await this.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.ownerId, ownerId))
      .orderBy(schema.brands.createdAt);

    if (brands.length === 0) return [];
    const brandIds = brands.map((brand) => brand.id);

    const [contexts, settings, productCounts, preferenceCounts, appliedSites] = await Promise.all([
      this.db
        .select()
        .from(schema.brandContexts)
        .where(inArray(schema.brandContexts.brandId, brandIds)),
      this.db
        .select()
        .from(schema.automationSettings)
        .where(inArray(schema.automationSettings.brandId, brandIds)),
      this.db
        .select({ brandId: schema.products.brandId, total: count() })
        .from(schema.products)
        .where(inArray(schema.products.brandId, brandIds))
        .groupBy(schema.products.brandId),
      this.db
        .select({ brandId: schema.brandPreferences.brandId, total: count() })
        .from(schema.brandPreferences)
        .where(inArray(schema.brandPreferences.brandId, brandIds))
        .groupBy(schema.brandPreferences.brandId),
      this.db
        .select({ brandId: schema.brandSiteProfiles.brandId })
        .from(schema.brandSiteProfiles)
        .where(
          and(
            inArray(schema.brandSiteProfiles.brandId, brandIds),
            isNotNull(schema.brandSiteProfiles.appliedAt),
          ),
        ),
    ]);

    const contextByBrand = new Map(contexts.map((row) => [row.brandId, row]));
    const settingsByBrand = new Map(settings.map((row) => [row.brandId, row]));
    const productsByBrand = new Map(productCounts.map((row) => [row.brandId, row.total]));
    const preferencesByBrand = new Map(preferenceCounts.map((row) => [row.brandId, row.total]));
    const sitedBrands = new Set(appliedSites.map((row) => row.brandId));

    // One insert for everything missing, then re-read only if we actually
    // created something — the steady state is no extra queries at all.
    const missingContext = brands.filter((brand) => !contextByBrand.has(brand.id));
    const missingSettings = brands.filter((brand) => !settingsByBrand.has(brand.id));

    if (missingContext.length > 0) {
      await this.db
        .insert(schema.brandContexts)
        .values(
          missingContext.map((brand) => ({
            brandId: brand.id,
            industry: brand.category,
            location: brand.location,
            audience: brand.audience,
            source: 'manual' as const,
          })),
        )
        .onConflictDoNothing({ target: schema.brandContexts.brandId });

      const created = await this.db
        .select()
        .from(schema.brandContexts)
        .where(inArray(schema.brandContexts.brandId, missingContext.map((brand) => brand.id)));
      for (const row of created) contextByBrand.set(row.brandId, row);
    }

    if (missingSettings.length > 0) {
      await this.db
        .insert(schema.automationSettings)
        .values(missingSettings.map((brand) => ({ brandId: brand.id })))
        .onConflictDoNothing({ target: schema.automationSettings.brandId });

      const created = await this.db
        .select()
        .from(schema.automationSettings)
        .where(inArray(schema.automationSettings.brandId, missingSettings.map((b) => b.id)));
      for (const row of created) settingsByBrand.set(row.brandId, row);
    }

    return brands.map((brand) => {
      const context = contextByBrand.get(brand.id);
      const automation = settingsByBrand.get(brand.id);
      const productCount = productsByBrand.get(brand.id) ?? 0;

      const goals = context?.goals ?? [];
      const competitors = context?.competitors ?? [];
      const contentPillars = context?.contentPillars ?? [];

      return {
        brandId: brand.id,
        brandName: brand.name,
        logoUrl: brand.logoUrl,
        colors: brand.colors,
        industry: context?.industry ?? null,
        location: context?.location ?? null,
        audience: context?.audience ?? null,
        goals,
        competitors,
        positioning: context?.positioning ?? null,
        contentPillars,
        notes: context?.notes ?? null,
        source: context?.source ?? 'manual',
        confirmedAt: context?.confirmedAt ?? null,
        productCount,
        preferenceCount: preferencesByBrand.get(brand.id) ?? 0,
        hasWebsiteContext: sitedBrands.has(brand.id),
        automation: {
          contentAutomationEnabled: automation?.contentAutomationEnabled ?? false,
          trendFrequency: automation?.trendFrequency ?? 'weekly',
          approvalPolicy: automation?.approvalPolicy ?? 'assist',
          lastResearchAt: automation?.lastResearchAt ?? null,
          nextResearchAt: automation?.nextResearchAt ?? null,
        },
        completeness: contextCompleteness({
          industry: context?.industry ?? null,
          location: context?.location ?? null,
          audience: context?.audience ?? null,
          goals,
          competitors,
          positioning: context?.positioning ?? null,
          contentPillars,
          productCount,
        }),
      };
    });
  }

  /** Everything known about the brand, in one round of queries. */
  async buildFullBrandContext(brandId: string, ownerId: string): Promise<FullBrandContext> {
    await this.assertBrandOwned(brandId, ownerId);

    const [brand] = await this.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);

    const [context, site, products, preferences, automation] = await Promise.all([
      this.ensureContext(brandId),
      // Only an *applied* import counts. The pipeline reads applied profiles
      // and nothing else (see BrandSiteService.apply), so including a pending
      // one here would show the user context their creatives are not using.
      this.db
        .select()
        .from(schema.brandSiteProfiles)
        .where(
          and(
            eq(schema.brandSiteProfiles.brandId, brandId),
            isNotNull(schema.brandSiteProfiles.appliedAt),
          ),
        )
        .limit(1),
      this.db.select().from(schema.products).where(eq(schema.products.brandId, brandId)),
      this.preferences.getTopPreferences(brandId),
      this.automation.ensureSettings(brandId),
    ]);

    const profile = site[0];
    const analysis = profile?.analysis as SiteAnalysis | null | undefined;

    return {
      brand: {
        id: brand.id,
        name: brand.name,
        logoUrl: brand.logoUrl,
        colors: brand.colors,
        tone: brand.tone,
        category: brand.category,
        audience: brand.audience,
        location: brand.location,
        languages: brand.languages,
        platforms: brand.platforms,
        bannedTopics: brand.bannedTopics,
        websiteUrl: brand.websiteUrl,
        socialHandles: brand.socialHandles,
      },
      context,
      site:
        profile && analysis && profile.appliedAt
          ? {
              sourceUrl: profile.sourceUrl,
              visualIdentity: analysis.visualIdentity,
              voiceSummary: analysis.voiceSummary,
              messagingThemes: analysis.messagingThemes,
              appliedAt: profile.appliedAt,
            }
          : null,
      products: products.map((product) => ({
        id: product.id,
        name: product.name,
        description: product.description,
        priceMinor: product.priceMinor,
        currency: product.currency,
        sellingPoints: product.sellingPoints,
      })),
      preferences,
      automation,
    };
  }

  /**
   * The slice one agent needs, and no more.
   *
   * Delegates to the Context Manager in `@bmas/db` rather than assembling its
   * own view. This service and the worker were building brand context
   * independently, which is how the same brand ends up described two different
   * ways depending on which process asked — the exact failure the Context
   * Manager exists to remove. The HTTP surface keeps the ownership check; the
   * manager takes a brandId that has already been authorised.
   *
   * `bannedTopics` is in every projection on purpose. It is the one field where
   * omitting it does active harm rather than merely losing quality.
   *
   * Takes `ownerId` and checks it here rather than trusting the caller to have
   * done so. This has no HTTP callers yet, and a projection builder that
   * happens to be safe only because nothing calls it is a trap for whoever
   * wires up the first route.
   */
  async getContextForAgent(
    brandId: string,
    ownerId: string,
    agentType: AgentType,
  ): Promise<Record<string, unknown>> {
    await this.assertBrandOwned(brandId, ownerId);
    await this.ensureContext(brandId);

    switch (agentType) {
      // Same context as trend research — see the header of
      // intelligence-research.ts for why the two agents share this shape
      // (industry, location, competitors, goals) despite asking different
      // questions of it.
      case 'trend':
      case 'intelligence':
        return { ...(await getTrendContext(this.db, brandId)) };

      case 'content':
        return { ...(await getContentContext(this.db, brandId, { includeTrend: true })) };

      // No dedicated projection yet — the Strategy Agent is Phase 4. Trend
      // context is the right superset for it in the meantime (market, goals,
      // competitors, products), and saying so is better than duplicating it
      // into a third shape that would immediately start drifting.
      case 'strategy':
        return { ...(await getTrendContext(this.db, brandId)) };

      // Reading outcomes: the goals the numbers are judged against, plus what
      // we already believe so it can confirm or overturn it.
      case 'performance': {
        const context = await getTrendContext(this.db, brandId);
        return { identity: context.identity, goals: context.goals, learnings: context.learnings };
      }
    }
  }

  /**
   * Records what an agent was handed.
   *
   * Best-effort by design: a snapshot is forensics, and failing a generation
   * because the audit write failed would trade a real outcome for a log line.
   */
  async recordSnapshot(
    brandId: string,
    agentType: AgentType,
    snapshot: Record<string, unknown>,
    usedInJobId?: string | null,
  ): Promise<void> {
    try {
      await this.db.insert(schema.contextSnapshots).values({
        brandId,
        agentType,
        snapshot,
        usedInJobId: usedInJobId ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `Could not record ${agentType} context snapshot for brand ${brandId}: ${String(error)}`,
      );
    }
  }

  /** Snapshots for a brand, newest first. The "what was this run told?" view. */
  async listSnapshots(brandId: string, ownerId: string, limit = 20) {
    await this.assertBrandOwned(brandId, ownerId);
    return this.db
      .select()
      .from(schema.contextSnapshots)
      .where(eq(schema.contextSnapshots.brandId, brandId))
      .orderBy(desc(schema.contextSnapshots.createdAt))
      .limit(limit);
  }

  /** User edits from the Brand Brain screen. Field-by-field, same rule the
   *  website apply flow follows: omitting a field leaves it alone. */
  async updateContext(
    brandId: string,
    ownerId: string,
    input: UpdateBrandContextInput,
  ): Promise<BrandContext> {
    await this.assertBrandOwned(brandId, ownerId);
    await this.ensureContext(brandId);

    const { confirm, ...fields } = input;
    const [updated] = await this.db
      .update(schema.brandContexts)
      .set({
        ...(fields.industry !== undefined ? { industry: fields.industry } : {}),
        ...(fields.location !== undefined ? { location: fields.location } : {}),
        ...(fields.audience !== undefined ? { audience: fields.audience } : {}),
        ...(fields.goals ? { goals: fields.goals } : {}),
        ...(fields.competitors ? { competitors: fields.competitors } : {}),
        ...(fields.positioning !== undefined ? { positioning: fields.positioning } : {}),
        ...(fields.contentPillars ? { contentPillars: fields.contentPillars } : {}),
        ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
        // A human touched it, so it is theirs now — the importer stops writing
        // here (see updateBrandContextFromWebsite).
        source: 'manual',
        ...(confirm ? { confirmedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.brandContexts.brandId, brandId))
      .returning();

    if (!updated) throw new Error('Update returned no row');
    return updated as BrandContext;
  }

  /**
   * Re-derives context from the website import already on file.
   *
   * Reuses the stored analysis rather than re-fetching: the expensive and
   * impolite half of an import is hitting someone else's server, and this needs
   * neither. An import that was never applied is ignored for the same reason
   * `buildFullBrandContext` ignores it — the pipeline does not read it, so the
   * Brand Brain must not either.
   */
  async refreshFromSiteProfile(brandId: string, ownerId: string): Promise<BrandContext> {
    await this.assertBrandOwned(brandId, ownerId);

    const [profile] = await this.db
      .select()
      .from(schema.brandSiteProfiles)
      .where(
        and(
          eq(schema.brandSiteProfiles.brandId, brandId),
          isNotNull(schema.brandSiteProfiles.appliedAt),
        ),
      )
      .limit(1);

    const analysis = profile?.analysis as SiteAnalysis | null | undefined;
    if (!analysis) {
      throw new NotFoundException(
        'No applied website import to refresh from. Import the brand website and apply it first.',
      );
    }

    return this.updateBrandContextFromWebsite(brandId, analysis);
  }

  /**
   * Fills the context from a website reading (1.6).
   *
   * Called after an import is applied. **Only fills blanks** — never overwrites
   * a value that is already there, and does nothing at all once the user has
   * confirmed the context. A re-import is a routine action (the site changed,
   * the first read was poor); silently reverting someone's corrections because
   * they refreshed is not a tradeoff worth making for slightly fresher prose.
   */
  async updateBrandContextFromWebsite(brandId: string, analysis: SiteAnalysis): Promise<BrandContext> {
    const context = await this.ensureContext(brandId);

    if (context.confirmedAt) {
      this.logger.log(`Brand ${brandId} context is user-confirmed; leaving the website import out of it.`);
      return context;
    }

    const filled: Record<string, unknown> = {};
    if (!context.industry && analysis.suggestedCategory) filled.industry = analysis.suggestedCategory;
    if (!context.audience && analysis.suggestedAudience) filled.audience = analysis.suggestedAudience;
    // `offering` is the model's one-sentence read of what the business sells —
    // the closest thing a homepage offers to a positioning statement, and the
    // field the analysis already keeps out of the image brief for its own
    // reasons (see siteAnalysisSchema). Context is exactly where it belongs.
    if (!context.positioning && analysis.offering) filled.positioning = analysis.offering;
    if (context.contentPillars.length === 0 && analysis.messagingThemes.length > 0) {
      filled.contentPillars = analysis.messagingThemes.slice(0, 6);
    }

    if (Object.keys(filled).length === 0) return context;

    const [updated] = await this.db
      .update(schema.brandContexts)
      .set({ ...filled, source: 'website', updatedAt: new Date() })
      .where(eq(schema.brandContexts.brandId, brandId))
      .returning();

    if (!updated) throw new Error('Update returned no row');
    return updated as BrandContext;
  }
}
