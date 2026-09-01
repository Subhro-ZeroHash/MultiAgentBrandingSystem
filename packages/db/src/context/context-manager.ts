import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { ApprovalPolicy, BrandCompetitor, SiteAnalysis, TrendFrequency } from '@bmas/shared';
import type { Database } from '../client.js';
import * as schema from '../schema/index.js';

/**
 * The Context Manager.
 *
 * Sits between the AI workflows and the brand's stored data, and answers one
 * question: *what does this particular task need to know?* Before it, three
 * places assembled brand context independently — `trend-research.ts` built its
 * own prompt block from the Brand Kit, `generate.ts` had `loadSiteIdentity` and
 * `loadTrendContext`, and `BrandContextService` had a third view for the API —
 * and none of them could see the goals, competitors, positioning or learned
 * preferences that `brand_contexts` and `brand_preferences` had been collecting.
 * The Brand Brain was being written and never read.
 *
 * Plain functions taking `db`, and living in `@bmas/db` rather than either app,
 * because both consumers need them and they cannot share a NestJS provider:
 * content-api injects services, content-worker is a plain Node process. This is
 * the one package both already depend on.
 *
 * ## Three kinds of memory
 *
 * Every task context is assembled from the same three layers, which differ in
 * how they age rather than in where they are stored:
 *
 *   - **Static** — the Brand Kit, the website reading, products, the stated
 *     context. Changes rarely; read from the existing source of truth, never
 *     copied into a second table.
 *   - **Dynamic** — what is true this week: the current trend, live campaigns,
 *     what was published recently. Bounded by recency and row caps, because
 *     the failure mode here is an unbounded history dump into a prompt.
 *   - **Learned** — what past outcomes taught us, from `brand_preferences`.
 *
 * ## What it deliberately does not do
 *
 * It does not return everything it can find. A trend query does not need the
 * colour palette; an image brief does not need the competitor list. Every field
 * a task does not use is prompt budget spent on nothing, and — more expensively
 * — an invitation for the model to work it into the output.
 */

/** How far back "recent" reaches, per task. Days. */
const RECENT_TREND_DAYS = 30;
const RECENT_FEEDBACK_DAYS = 90;

/** Row caps. A prompt that grows with account age eventually degrades the
 *  output and always costs more; these bound both. */
const MAX_PRODUCTS = 12;
/** How many recent research runs the planner reaches back through for
 *  evidence. Two: enough that a plan drafted right after a quiet run still has
 *  material, few enough that it is not planning around last month's news. */
const MAX_PLANNING_RUNS = 2;
/** Caps on what reaches the planner's prompt. These are the biggest lever on
 *  its input cost, and past roughly this many the model starts averaging
 *  across ideas instead of choosing between them. */
const MAX_PLANNING_OPPORTUNITIES = 12;
const MAX_PLANNING_INTELLIGENCE = 8;
const MAX_RECENT_TOPICS = 15;
const MAX_LEARNED = 8;
const MAX_REJECTED_PATTERNS = 6;

/** Learned preferences below this are noise in a prompt: a model reads any
 *  statement put in front of it as fact regardless of the number attached, so
 *  filtering is the only thing that actually works. */
const MIN_PROMPT_CONFIDENCE = 0.4;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

export interface ContextProduct {
  id: string;
  name: string;
  description: string | null;
  sellingPoints: string[];
  priceMinor: number | null;
  currency: string;
}

export interface ContextBrandIdentity {
  brandId: string;
  brandName: string;
  industry: string | null;
  location: string | null;
  audience: string | null;
  tone: string[];
  languages: string[];
  /** Always present in every task context. The one field where omitting it
   *  does active harm rather than merely costing quality. */
  bannedTopics: string[];
}

export interface ContextTrendHighlight {
  title: string;
  summary: string;
  recommendation: string;
  score: number;
}

/** A learning, flattened to the sentence a prompt actually uses. */
export interface ContextLearning {
  type: string;
  summary: string;
  value: string | null;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Internal loaders
// ---------------------------------------------------------------------------

async function loadBrandRow(db: Database, brandId: string) {
  const [brand] = await db
    .select()
    .from(schema.brands)
    .where(eq(schema.brands.id, brandId))
    .limit(1);
  if (!brand) throw new Error(`Brand ${brandId} not found`);
  return brand;
}

async function loadStatedContext(db: Database, brandId: string) {
  const [row] = await db
    .select()
    .from(schema.brandContexts)
    .where(eq(schema.brandContexts.brandId, brandId))
    .limit(1);
  return row ?? null;
}

async function loadProducts(db: Database, brandId: string): Promise<ContextProduct[]> {
  const rows = await db
    .select({
      id: schema.products.id,
      name: schema.products.name,
      description: schema.products.description,
      sellingPoints: schema.products.sellingPoints,
      priceMinor: schema.products.priceMinor,
      currency: schema.products.currency,
    })
    .from(schema.products)
    .where(eq(schema.products.brandId, brandId))
    .orderBy(schema.products.createdAt)
    .limit(MAX_PRODUCTS);
  return rows;
}

/**
 * The website reading, and only if the user opted it into generation.
 *
 * The three opt-ins are read independently on purpose — a user may want the art
 * direction but not the logo. This mirrors `loadSiteIdentity` in the worker,
 * which it replaces; the rule now lives in one place.
 */
async function loadSiteIdentity(db: Database, brandId: string) {
  const [row] = await db
    .select({
      sourceUrl: schema.brandSiteProfiles.sourceUrl,
      analysis: schema.brandSiteProfiles.analysis,
      appliedAt: schema.brandSiteProfiles.appliedAt,
      logoStorageKey: schema.brandSiteProfiles.logoStorageKey,
      logoAppliedAt: schema.brandSiteProfiles.logoAppliedAt,
      styleReferenceKeys: schema.brandSiteProfiles.styleReferenceKeys,
      styleReferencesAppliedAt: schema.brandSiteProfiles.styleReferencesAppliedAt,
    })
    .from(schema.brandSiteProfiles)
    .where(eq(schema.brandSiteProfiles.brandId, brandId))
    .limit(1);

  if (!row) {
    return { siteIdentity: null, sourceUrl: null, logoStorageKey: null, styleReferenceKeys: [] };
  }
  return {
    siteIdentity: row.appliedAt ? ((row.analysis as SiteAnalysis | null) ?? null) : null,
    sourceUrl: row.appliedAt ? row.sourceUrl : null,
    logoStorageKey: row.logoAppliedAt ? row.logoStorageKey : null,
    styleReferenceKeys: row.styleReferencesAppliedAt ? (row.styleReferenceKeys ?? []) : [],
  };
}

/** Every dimension the platform learns about, so each can be queried on its
 *  own. Mirrors `preferenceTypeSchema` in @bmas/shared. */
const PREFERENCE_TYPES = [
  'content_format',
  'posting_time',
  'visual_style',
  'tone',
  'topic',
] as const;

/**
 * Current beliefs: the newest observation per type, above the confidence floor.
 *
 * One indexed query per type rather than "take the N newest rows, then dedupe
 * by type". That first approach is what this originally did, and it silently
 * starved: regenerations are by far the most frequent feedback action and each
 * writes a `visual_style` row, so after roughly fifty of them every row in the
 * window was visual_style and the brand's high-confidence findings about
 * posting time, format and tone stopped reaching prompts entirely. The rows
 * were still in the table — measured, correct, and invisible. A learning system
 * that quietly stops learning is worse than one that never started, because
 * nothing about it looks broken.
 *
 * Five index seeks on `brand_preferences_brand_type_created_idx`, each
 * returning one row, is cheaper than the fifty-row scan it replaces.
 */
async function loadLearnings(db: Database, brandId: string): Promise<ContextLearning[]> {
  const perType = await Promise.all(
    PREFERENCE_TYPES.map(async (preferenceType) => {
      const [row] = await db
        .select()
        .from(schema.brandPreferences)
        .where(
          and(
            eq(schema.brandPreferences.brandId, brandId),
            eq(schema.brandPreferences.preferenceType, preferenceType),
            gte(schema.brandPreferences.confidence, MIN_PROMPT_CONFIDENCE),
          ),
        )
        .orderBy(desc(schema.brandPreferences.createdAt))
        .limit(1);
      return row;
    }),
  );

  return perType
    .filter((row): row is NonNullable<typeof row> => row != null)
    .map((row) => ({
      type: row.preferenceType,
      summary: row.preference.summary,
      value: row.preference.value ?? null,
      confidence: row.confidence,
    }))
    .slice(0, MAX_LEARNED);
}

/** The brand's most recent successful research run, best opportunity first. */
async function loadCurrentTrend(
  db: Database,
  brandId: string,
): Promise<ContextTrendHighlight | null> {
  const [run] = await db
    .select({ id: schema.trendResearchRuns.id })
    .from(schema.trendResearchRuns)
    .where(
      and(
        eq(schema.trendResearchRuns.brandId, brandId),
        eq(schema.trendResearchRuns.status, 'succeeded'),
      ),
    )
    .orderBy(desc(schema.trendResearchRuns.createdAt))
    .limit(1);
  if (!run) return null;

  const opportunities = await db
    .select({
      title: schema.trendOpportunities.title,
      summary: schema.trendOpportunities.summary,
      recommendation: schema.trendOpportunities.recommendation,
      score: schema.trendOpportunities.score,
    })
    .from(schema.trendOpportunities)
    .where(eq(schema.trendOpportunities.runId, run.id));
  if (opportunities.length === 0) return null;

  const top = [...opportunities].sort((a, b) => b.score.overall - a.score.overall)[0]!;
  return {
    title: top.title,
    summary: top.summary,
    recommendation: top.recommendation,
    score: top.score.overall,
  };
}

/**
 * Topics already suggested to this brand recently.
 *
 * Feeds the trend prompt as a "don't repeat these" list. Research runs on a
 * cadence against a slow-moving industry return substantially the same
 * opportunities every time otherwise, which reads to the user as the
 * platform having no memory — precisely the problem this layer exists to fix.
 */
async function loadRecentTopics(db: Database, brandId: string): Promise<string[]> {
  const rows = await db
    .select({ title: schema.trendOpportunities.title })
    .from(schema.trendOpportunities)
    .innerJoin(
      schema.trendResearchRuns,
      eq(schema.trendOpportunities.runId, schema.trendResearchRuns.id),
    )
    .where(
      and(
        eq(schema.trendResearchRuns.brandId, brandId),
        gte(schema.trendResearchRuns.createdAt, daysAgo(RECENT_TREND_DAYS)),
      ),
    )
    .orderBy(desc(schema.trendResearchRuns.createdAt))
    .limit(MAX_RECENT_TOPICS * 2);

  return [...new Set(rows.map((row) => row.title))].slice(0, MAX_RECENT_TOPICS);
}

/**
 * What the user has pushed back on lately.
 *
 * Derived from rows that already exist rather than from a new feedback table:
 * a regeneration instruction is a literal statement of what was wrong with an
 * image ("make the background lighter"), and a rejected post is a rejection of
 * whatever it depicted. Both were already being recorded for other reasons and
 * neither was ever read back.
 */
async function loadRejectedPatterns(db: Database, brandId: string): Promise<string[]> {
  const since = daysAgo(RECENT_FEEDBACK_DAYS);

  const edits = await db
    .select({ instruction: schema.assetEdits.instruction })
    .from(schema.assetEdits)
    .innerJoin(schema.creativeAssets, eq(schema.assetEdits.rootAssetId, schema.creativeAssets.id))
    .innerJoin(schema.generationJobs, eq(schema.creativeAssets.jobId, schema.generationJobs.id))
    .where(and(eq(schema.generationJobs.brandId, brandId), gte(schema.assetEdits.createdAt, since)))
    .orderBy(desc(schema.assetEdits.createdAt))
    .limit(MAX_REJECTED_PATTERNS);

  return [...new Set(edits.map((row) => row.instruction.trim()).filter(Boolean))].slice(
    0,
    MAX_REJECTED_PATTERNS,
  );
}

// ---------------------------------------------------------------------------
// 1. Trend analysis context
// ---------------------------------------------------------------------------

export interface TrendTaskContext {
  identity: ContextBrandIdentity;
  positioning: string | null;
  goals: string[];
  competitors: BrandCompetitor[];
  contentPillars: string[];
  products: ContextProduct[];
  /** Titles already suggested in the last 30 days — do not repeat them. */
  recentTopics: string[];
  learnings: ContextLearning[];
}

/**
 * Context for the Trend Research agent.
 *
 * Everything about *what business this is and what it wants*; nothing about how
 * it looks. A trend query cares about the market, not the palette.
 */
export async function getTrendContext(db: Database, brandId: string): Promise<TrendTaskContext> {
  const [brand, stated, products, recentTopics, learnings] = await Promise.all([
    loadBrandRow(db, brandId),
    loadStatedContext(db, brandId),
    loadProducts(db, brandId),
    loadRecentTopics(db, brandId),
    loadLearnings(db, brandId),
  ]);

  return {
    identity: {
      brandId: brand.id,
      brandName: brand.name,
      // The stated context wins over the Brand Kit's taxonomy `category`: it is
      // the phrase the user actually described their business with, and a
      // search query built from it returns better results.
      industry: stated?.industry ?? brand.category,
      location: stated?.location ?? brand.location,
      audience: stated?.audience ?? brand.audience,
      tone: brand.tone,
      languages: brand.languages,
      bannedTopics: brand.bannedTopics,
    },
    positioning: stated?.positioning ?? null,
    goals: stated?.goals ?? [],
    competitors: stated?.competitors ?? [],
    contentPillars: stated?.contentPillars ?? [],
    products,
    recentTopics,
    learnings,
  };
}

// ---------------------------------------------------------------------------
// 2. Content / creative generation context
// ---------------------------------------------------------------------------

export interface ContentTaskContext {
  identity: ContextBrandIdentity;
  colors: string[];
  positioning: string | null;
  contentPillars: string[];
  /** The applied website reading — art direction and voice. Null unless the
   *  user opted it into generation. */
  siteIdentity: SiteAnalysis | null;
  logoStorageKey: string | null;
  styleReferenceKeys: string[];
  products: ContextProduct[];
  /** The brand's best current trend idea, for campaigns that lean on one. */
  currentTrend: ContextTrendHighlight | null;
  learnings: ContextLearning[];
  /** Recent "make it X instead" instructions — what to avoid repeating. */
  rejectedPatterns: string[];
}

/**
 * Context for the content and creative generation pipeline.
 *
 * Includes the visual identity the trend context omits, and adds the two
 * things generation had no access to before: what the brand stands for
 * (positioning, pillars) and what the user has already pushed back on.
 *
 * `includeTrend` is a parameter rather than always-on because a uniform-mode
 * job — every scheduled-campaign generation — never reads it, and the query is
 * two round trips for a field that would be discarded.
 */
export async function getContentContext(
  db: Database,
  brandId: string,
  options: { includeTrend?: boolean } = {},
): Promise<ContentTaskContext> {
  const [brand, stated, site, products, learnings, rejectedPatterns, currentTrend] =
    await Promise.all([
      loadBrandRow(db, brandId),
      loadStatedContext(db, brandId),
      loadSiteIdentity(db, brandId),
      loadProducts(db, brandId),
      loadLearnings(db, brandId),
      loadRejectedPatterns(db, brandId),
      options.includeTrend ? loadCurrentTrend(db, brandId) : Promise.resolve(null),
    ]);

  return {
    identity: {
      brandId: brand.id,
      brandName: brand.name,
      industry: stated?.industry ?? brand.category,
      location: stated?.location ?? brand.location,
      audience: stated?.audience ?? brand.audience,
      tone: brand.tone,
      languages: brand.languages,
      bannedTopics: brand.bannedTopics,
    },
    colors: brand.colors,
    positioning: stated?.positioning ?? null,
    contentPillars: stated?.contentPillars ?? [],
    siteIdentity: site.siteIdentity,
    logoStorageKey: site.logoStorageKey,
    styleReferenceKeys: site.styleReferenceKeys,
    products,
    currentTrend,
    learnings,
    rejectedPatterns,
  };
}

// ---------------------------------------------------------------------------
// 3. Publishing context
// ---------------------------------------------------------------------------

export interface PublishingTaskContext {
  brandId: string;
  brandName: string;
  languages: string[];
  bannedTopics: string[];
  approvalPolicy: ApprovalPolicy;
  autoPublishEnabled: boolean;
  contentAutomationEnabled: boolean;
  trendFrequency: TrendFrequency;
  /** Connected accounts, **without credentials** — the encrypted token column
   *  is deliberately never selected here. Publishing code fetches the token
   *  through the existing social service, which owns decryption; a context
   *  object gets logged and snapshotted, and a token must never ride along. */
  accounts: Array<{
    id: string;
    platform: string;
    displayName: string;
    status: string;
  }>;
  /** Learned best posting time, when one has been observed. */
  preferredPostingTime: string | null;
  /** Posts published in the last 30 days — how busy this feed already is. */
  recentPublishCount: number;
}

/**
 * Context for the publishing/scheduling decision.
 *
 * Deliberately credential-free: see `accounts`. Everything here is safe to log
 * and to store in a context snapshot.
 */
export async function getPublishingContext(
  db: Database,
  brandId: string,
): Promise<PublishingTaskContext> {
  const brand = await loadBrandRow(db, brandId);

  const [settings, accounts, learnings, recentPublished] = await Promise.all([
    db
      .select()
      .from(schema.automationSettings)
      .where(eq(schema.automationSettings.brandId, brandId))
      .limit(1),
    db
      .select({
        id: schema.socialAccounts.id,
        platform: schema.socialAccounts.platform,
        displayName: schema.socialAccounts.displayName,
        status: schema.socialAccounts.status,
      })
      .from(schema.socialAccounts)
      .where(eq(schema.socialAccounts.ownerId, brand.ownerId)),
    loadLearnings(db, brandId),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.scheduledPosts)
      .where(
        and(
          eq(schema.scheduledPosts.brandId, brandId),
          eq(schema.scheduledPosts.status, 'posted'),
          gte(schema.scheduledPosts.scheduledFor, daysAgo(30)),
        ),
      ),
  ]);

  const automation = settings[0];

  return {
    brandId: brand.id,
    brandName: brand.name,
    languages: brand.languages,
    bannedTopics: brand.bannedTopics,
    // Defaults match the column defaults: a brand with no settings row is
    // fully manual, which is the safe reading when the answer is "publish
    // without asking?".
    approvalPolicy: automation?.approvalPolicy ?? 'assist',
    autoPublishEnabled: automation?.autoPublishEnabled ?? false,
    contentAutomationEnabled: automation?.contentAutomationEnabled ?? false,
    trendFrequency: automation?.trendFrequency ?? 'weekly',
    accounts,
    preferredPostingTime:
      learnings.find((learning) => learning.type === 'posting_time')?.value ?? null,
    recentPublishCount: recentPublished[0]?.total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 4. Campaign context
// ---------------------------------------------------------------------------

export interface CampaignTaskContext {
  campaignId: string;
  brandId: string;
  campaignType: string;
  styleTemplate: string;
  outputFormat: string;
  totalDays: number;
  postsPerDay: number;
  status: string;
  product: ContextProduct | null;
  /** How the campaign is tracking: what has gone out, what is waiting. */
  postCounts: { posted: number; pendingApproval: number; rejected: number; upcoming: number };
}

/**
 * Context for one scheduled campaign.
 *
 * Scoped by brand as well as id so a campaign id from another account cannot
 * be read through this path (Rule 7).
 */
export async function getCampaignContext(
  db: Database,
  brandId: string,
  campaignId: string,
): Promise<CampaignTaskContext | null> {
  const [campaign] = await db
    .select()
    .from(schema.scheduledCampaigns)
    .where(
      and(
        eq(schema.scheduledCampaigns.id, campaignId),
        eq(schema.scheduledCampaigns.brandId, brandId),
      ),
    )
    .limit(1);
  if (!campaign) return null;

  const [product] = await db
    .select({
      id: schema.products.id,
      name: schema.products.name,
      description: schema.products.description,
      sellingPoints: schema.products.sellingPoints,
      priceMinor: schema.products.priceMinor,
      currency: schema.products.currency,
    })
    .from(schema.products)
    .where(eq(schema.products.id, campaign.productId))
    .limit(1);

  const counts = await db
    .select({ status: schema.scheduledPosts.status, total: sql<number>`count(*)::int` })
    .from(schema.scheduledPosts)
    .where(eq(schema.scheduledPosts.campaignId, campaignId))
    .groupBy(schema.scheduledPosts.status);

  const byStatus = new Map(counts.map((row) => [row.status, row.total]));

  return {
    campaignId: campaign.id,
    brandId: campaign.brandId,
    campaignType: campaign.campaignType,
    styleTemplate: campaign.styleTemplate,
    outputFormat: campaign.outputFormat,
    totalDays: campaign.totalDays,
    postsPerDay: campaign.postsPerDay,
    status: campaign.status,
    product: product ?? null,
    postCounts: {
      posted: byStatus.get('posted') ?? 0,
      pendingApproval: byStatus.get('pending_approval') ?? 0,
      rejected: byStatus.get('rejected') ?? 0,
      upcoming: (byStatus.get('approved') ?? 0) + (byStatus.get('pending_generation') ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Observability — context snapshots
// ---------------------------------------------------------------------------

/**
 * Replaces the website analysis with a reference to it.
 *
 * Measured at 3.2 KB of a 5.2 KB content snapshot — 62% of every row, and the
 * same text every time, because a site is read once at setup and re-read maybe
 * once a year. Stored verbatim per generation that projects to ~38 MB/year for
 * a single brand at twenty generations a day, essentially all of it duplicate.
 *
 * What replaces it still answers the question a snapshot exists to answer:
 * `appliedAt` identifies *which* reading was in force, and the current text is
 * one join away in `brand_site_profiles`. The honest limitation is that a
 * re-import overwrites that row, so the prose behind an older snapshot is gone
 * — `appliedAt` is what tells you that happened rather than letting you read a
 * newer analysis and mistake it for the one that ran. Everything volatile
 * (learnings, rejected patterns, the trend, positioning) is still stored in
 * full, because none of it can be recovered from anywhere else.
 */
function trimSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const site = snapshot.siteIdentity as { voiceSummary?: string } | null | undefined;
  if (!site) return snapshot;

  return {
    ...snapshot,
    siteIdentity: {
      // A one-line marker of which reading this was, so a snapshot is still
      // legible without the join in the common case.
      voiceSummary: site.voiceSummary?.slice(0, 200) ?? null,
      storedIn: 'core.brand_site_profiles.analysis',
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Planning context — what the Marketing Planner reads
// ---------------------------------------------------------------------------

/** One live opportunity, flattened for the planner's prompt. */
export interface ContextOpportunity {
  id: string;
  title: string;
  summary: string;
  recommendation: string;
  contentType: string;
  actionTier: string;
  productId: string | null;
  score: number;
}

/** One piece of competitor/market intelligence worth planning around. */
export interface ContextIntelligence {
  id: string;
  title: string;
  summary: string;
  /** The planner's most useful field: the analyst's own reason this matters,
   *  rather than the raw finding. */
  whyItMatters: string;
  category: string;
  urgency: string;
}

/**
 * Everything the Marketing Planner is handed.
 *
 * Deliberately a superset of `TrendTaskContext` rather than its own parallel
 * loader: a plan is a judgment about the same business the trend agent studies,
 * and duplicating the identity loaders is how the two silently drift into
 * describing the brand differently. What planning adds is the *outside* view —
 * what the research agents have actually found, and how visible the brand
 * currently is — because a plan that cannot cite evidence is just an opinion.
 */
export interface PlanningTaskContext extends TrendTaskContext {
  /** Newest un-actioned opportunities, best-scoring first. */
  opportunities: ContextOpportunity[];
  intelligence: ContextIntelligence[];
  /** Latest GEO visibility score, or null if the brand has never been probed. */
  geoScore: number | null;
  /** Headline of the plan currently in force, so a revision can acknowledge
   *  what it is replacing instead of silently contradicting it. */
  currentPlanHeadline: string | null;
  /** Titles already proposed by the active plan — never propose them again. */
  currentPlanTitles: string[];
}

export async function getPlanningContext(
  db: Database,
  brandId: string,
): Promise<PlanningTaskContext> {
  const [base, opportunities, intelligence, geoScore, currentPlan] = await Promise.all([
    getTrendContext(db, brandId),
    loadLiveOpportunities(db, brandId),
    loadLiveIntelligence(db, brandId),
    loadLatestGeoScore(db, brandId),
    loadActivePlanSummary(db, brandId),
  ]);

  return {
    ...base,
    opportunities,
    intelligence,
    geoScore,
    currentPlanHeadline: currentPlan?.headline ?? null,
    currentPlanTitles: currentPlan?.titles ?? [],
  };
}

/** Opportunities are per-run, so this reaches through the brand's runs rather
 *  than filtering opportunities directly — they carry no brandId of their own. */
async function loadLiveOpportunities(db: Database, brandId: string): Promise<ContextOpportunity[]> {
  const runs = await db
    .select({ id: schema.trendResearchRuns.id })
    .from(schema.trendResearchRuns)
    .where(eq(schema.trendResearchRuns.brandId, brandId))
    .orderBy(desc(schema.trendResearchRuns.createdAt))
    .limit(MAX_PLANNING_RUNS);
  if (runs.length === 0) return [];

  const rows = await db
    .select({
      id: schema.trendOpportunities.id,
      title: schema.trendOpportunities.title,
      summary: schema.trendOpportunities.summary,
      recommendation: schema.trendOpportunities.recommendation,
      contentType: schema.trendOpportunities.contentType,
      actionTier: schema.trendOpportunities.actionTier,
      productId: schema.trendOpportunities.productId,
      score: schema.trendOpportunities.score,
      createdAt: schema.trendOpportunities.createdAt,
    })
    .from(schema.trendOpportunities)
    .where(
      and(
        inArray(
          schema.trendOpportunities.runId,
          runs.map((r) => r.id),
        ),
        // 'ignored' stays ignored — re-proposing something the user already
        // dismissed is the fastest way to lose their trust in the whole feed —
        // and 'working_on' is already being acted on, so planning it again
        // would duplicate work in flight.
        inArray(schema.trendOpportunities.status, ['new', 'saved']),
      ),
    )
    .orderBy(desc(schema.trendOpportunities.createdAt))
    .limit(MAX_PLANNING_OPPORTUNITIES);

  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      recommendation: r.recommendation,
      contentType: String(r.contentType),
      actionTier: String(r.actionTier),
      productId: r.productId,
      score: typeof r.score?.overall === 'number' ? r.score.overall : 0,
    }))
    .sort((a, b) => b.score - a.score);
}

async function loadLiveIntelligence(db: Database, brandId: string): Promise<ContextIntelligence[]> {
  const runs = await db
    .select({ id: schema.intelligenceRuns.id })
    .from(schema.intelligenceRuns)
    .where(eq(schema.intelligenceRuns.brandId, brandId))
    .orderBy(desc(schema.intelligenceRuns.createdAt))
    .limit(MAX_PLANNING_RUNS);
  if (runs.length === 0) return [];

  const rows = await db
    .select({
      id: schema.intelligenceItems.id,
      title: schema.intelligenceItems.title,
      summary: schema.intelligenceItems.summary,
      whyItMatters: schema.intelligenceItems.whyItMatters,
      category: schema.intelligenceItems.category,
      urgency: schema.intelligenceItems.urgency,
    })
    .from(schema.intelligenceItems)
    .where(
      inArray(
        schema.intelligenceItems.runId,
        runs.map((r) => r.id),
      ),
    )
    .orderBy(desc(schema.intelligenceItems.createdAt))
    .limit(MAX_PLANNING_INTELLIGENCE);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    whyItMatters: r.whyItMatters,
    category: String(r.category),
    urgency: String(r.urgency),
  }));
}

/** GEO's own tables, read-only and best-effort: visibility is useful context
 *  for a plan but never a reason to fail one, and the two products deploy
 *  independently (CLAUDE.md rule 4). */
async function loadLatestGeoScore(db: Database, brandId: string): Promise<number | null> {
  try {
    const [row] = await db
      .select({ score: schema.visibilitySnapshots.geoScore })
      .from(schema.visibilitySnapshots)
      .where(eq(schema.visibilitySnapshots.brandId, brandId))
      .orderBy(desc(schema.visibilitySnapshots.periodStart))
      .limit(1);
    return row?.score ?? null;
  } catch {
    return null;
  }
}

async function loadActivePlanSummary(
  db: Database,
  brandId: string,
): Promise<{ headline: string; titles: string[] } | null> {
  const [plan] = await db
    .select({ id: schema.marketingPlans.id, headline: schema.marketingPlans.headline })
    .from(schema.marketingPlans)
    .where(
      and(eq(schema.marketingPlans.brandId, brandId), eq(schema.marketingPlans.status, 'active')),
    )
    .limit(1);
  if (!plan) return null;

  const items = await db
    .select({ title: schema.planItems.title })
    .from(schema.planItems)
    .where(eq(schema.planItems.planId, plan.id));

  return { headline: plan.headline, titles: items.map((i) => i.title) };
}

/**
 * Records what an agent was actually handed (Rule 8).
 *
 * Best-effort without exception: a snapshot is forensics, and failing a paid
 * generation because an audit insert failed trades a real outcome for a log
 * line. Callers do not await a result they can act on.
 */
export async function recordContextSnapshot(
  db: Database,
  input: {
    brandId: string;
    agentType: string;
    snapshot: Record<string, unknown>;
    usedInJobId?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(schema.contextSnapshots).values({
      brandId: input.brandId,
      agentType: input.agentType,
      snapshot: trimSnapshot(input.snapshot),
      usedInJobId: input.usedInJobId ?? null,
    });
  } catch (error) {
    console.error(
      `[context] could not record the ${input.agentType} snapshot for brand ${input.brandId}:`,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Feedback capture — turning user actions into learned memory
// ---------------------------------------------------------------------------

/** What the user did. Each maps to a different confidence, below. */
export type FeedbackKind = 'approved' | 'rejected' | 'regenerated' | 'edited' | 'variant_selected';

/**
 * How much one action of each kind is worth, 0-1.
 *
 * Rejections and regenerations score highest because they are unambiguous and
 * costly to give: a user who asks for a change has told us exactly what was
 * wrong. An approval is the weakest signal in the set — "good enough to ship"
 * is not the same as "do more of this", and treating it as one is how a system
 * concludes that whatever it happened to produce first is what the brand wants.
 *
 * All well under 1: a single action is an anecdote. Phase 5's analyzer, which
 * sees aggregates, is what should record high-confidence findings.
 */
export const FEEDBACK_CONFIDENCE: Record<FeedbackKind, number> = {
  rejected: 0.5,
  regenerated: 0.5,
  edited: 0.45,
  variant_selected: 0.4,
  // Load-bearing: strictly below MIN_PROMPT_CONFIDENCE, so a single approval
  // never becomes the newest prompt-visible learning for its type. An approval
  // says "this was good enough to ship" and nothing about *why*, so promoting
  // one into a brief would displace a real measured finding with a sentence
  // carrying no direction. Pinned by a test — raise this and approvals start
  // reaching prompts.
  approved: 0.25,
};

/** Which dimension each kind of feedback teaches us about. */
const FEEDBACK_TYPE: Record<FeedbackKind, 'visual_style' | 'content_format' | 'topic'> = {
  rejected: 'topic',
  regenerated: 'visual_style',
  edited: 'visual_style',
  variant_selected: 'visual_style',
  approved: 'content_format',
};

/**
 * Turns a user action into a learned preference.
 *
 * Writes to `brand_preferences` rather than a new feedback table: that table is
 * already append-only, already carries a confidence and a source reference, and
 * is already what the Context Manager reads. A parallel table would be a second
 * source of truth for the same question.
 *
 * Best-effort, like snapshots — a failed insert must never fail the approval or
 * rejection the user actually asked for.
 */
export async function recordFeedbackSignal(
  db: Database,
  input: {
    brandId: string;
    kind: FeedbackKind;
    /** What happened, phrased as a finding — this string reaches prompts. */
    summary: string;
    /** The discrete value being taught, when there is one. */
    value?: string | null;
    /** The scheduled post this came from, when it was a post-level action. */
    sourcePostId?: string | null;
    /** Anything else worth keeping; not read by prompts. */
    detail?: Record<string, unknown>;
    /** Overrides `FEEDBACK_TYPE[kind]`. The default table maps each kind to
     *  the one dimension generation feedback teaches — `rejected` always
     *  means "wrong topic", `regenerated` always means "wrong visual style".
     *  A trend idea ignored, or a lead dismissed, is a rejection too, but of a
     *  *topic* specifically, whatever kind best fits the action semantically
     *  (`rejected` for "ignore", `variant_selected` for "work on this" — a
     *  chosen direction, same shape as picking a creative variant). Confidence
     *  still comes from `kind` either way; only which dimension the row is
     *  filed under changes. */
    type?: (typeof PREFERENCE_TYPES)[number];
  },
): Promise<void> {
  try {
    await db.insert(schema.brandPreferences).values({
      brandId: input.brandId,
      preferenceType: input.type ?? FEEDBACK_TYPE[input.kind],
      preference: {
        summary: input.summary,
        ...(input.value ? { value: input.value } : {}),
        sampleSize: 1,
        feedbackKind: input.kind,
        ...(input.detail ?? {}),
      },
      confidence: FEEDBACK_CONFIDENCE[input.kind],
      learnedFrom: input.sourcePostId ?? null,
    });
  } catch (error) {
    console.error(
      `[context] could not record ${input.kind} feedback for brand ${input.brandId}:`,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

/**
 * Renders a task context as prompt lines.
 *
 * Kept beside the assembly so the two cannot drift, and so every agent
 * describes the brand the same way. Empty fields are dropped rather than sent
 * as "unspecified" — a labelled blank still spends tokens and still invites the
 * model to fill it in.
 */
export function renderBrandContextLines(context: TrendTaskContext | ContentTaskContext): string[] {
  const lines: string[] = [];
  const { identity } = context;

  lines.push(`Brand: ${identity.brandName}.`);
  if (identity.industry) lines.push(`Industry: ${identity.industry}.`);
  if (identity.location) lines.push(`Trades from: ${identity.location}.`);
  if (identity.audience) lines.push(`Audience: ${identity.audience}.`);
  if (identity.tone.length) lines.push(`Voice: ${identity.tone.join(', ')}.`);
  if (context.positioning) lines.push(`Positioning: ${context.positioning}`);
  if (context.contentPillars.length) {
    lines.push(`Posts about: ${context.contentPillars.join(', ')}.`);
  }

  if ('goals' in context && context.goals.length) {
    lines.push(`Current goals: ${context.goals.join('; ')}.`);
  }
  if ('competitors' in context && context.competitors.length) {
    lines.push(
      `Competitors: ${context.competitors
        .map((competitor) =>
          competitor.note ? `${competitor.name} (${competitor.note})` : competitor.name,
        )
        .join(', ')}.`,
    );
  }

  if (context.products.length) {
    lines.push(
      `Products: ${context.products
        .map((product) =>
          product.sellingPoints.length
            ? `${product.name} (${product.sellingPoints.slice(0, 3).join(', ')})`
            : product.name,
        )
        .join('; ')}.`,
    );
  }

  if (context.learnings.length) {
    lines.push(
      `What has worked for this brand before: ${context.learnings
        .map((learning) => learning.summary)
        .join(' ')}`,
    );
  }

  return lines;
}

// Re-exported so consumers can widen the caps deliberately rather than by
// editing this file, and so tests can assert against the real numbers.
export const CONTEXT_LIMITS = {
  RECENT_TREND_DAYS,
  RECENT_FEEDBACK_DAYS,
  MAX_PRODUCTS,
  MAX_PLANNING_RUNS,
  MAX_PLANNING_OPPORTUNITIES,
  MAX_PLANNING_INTELLIGENCE,
  MAX_RECENT_TOPICS,
  MAX_LEARNED,
  MAX_REJECTED_PATTERNS,
  MIN_PROMPT_CONFIDENCE,
} as const;
