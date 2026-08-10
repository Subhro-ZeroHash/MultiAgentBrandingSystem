import { z } from 'zod';
import { entityIdSchema, partialForUpdate } from '../common.js';

/**
 * Brand Brain — the persistent, per-brand understanding every agent reads from.
 *
 * The Brand Kit (`core.brands`) says what the brand *is*: name, palette, tone,
 * banned topics. That is shared with GEO and stays deliberately small. This
 * file covers what the marketing side needs to *reason* with — the goals it is
 * working toward, who it competes against, what it has learned about what
 * works, and how much of the loop it is allowed to run unattended.
 *
 * All of it is content-workstream owned, hence `content` rather than `core`.
 *
 * Four separate concerns, four tables, because they change on completely
 * different clocks:
 *   - `brand_contexts`      — stated facts. Edited by a human, occasionally.
 *   - `brand_preferences`   — learned facts. Appended by the system, often.
 *   - `automation_settings` — permissions. Edited by a human, rarely.
 *   - `context_snapshots`   — what an agent was actually told, at one moment.
 */

// ---------------------------------------------------------------------------
// Brand context (stated facts)
// ---------------------------------------------------------------------------

export const brandCompetitorSchema = z.object({
  name: z.string().min(1).max(120),
  websiteUrl: z.string().url().nullish(),
  /** Why they matter to this brand — "cheaper, same audience", "the one every
   *  customer names". One line; the strategy prompt reads it verbatim. */
  note: z.string().max(300).nullish(),
});
export type BrandCompetitor = z.infer<typeof brandCompetitorSchema>;

/**
 * Where a context field came from.
 *
 * Tracked because the website importer and the user write to the same row.
 * An import must never overwrite something a person confirmed — see
 * `BrandContextService.updateBrandContextFromWebsite`, which only fills gaps.
 */
export const contextSourceSchema = z.enum(['manual', 'website', 'inferred']);
export type ContextSource = z.infer<typeof contextSourceSchema>;

export const brandContextSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  /** What business this is, in the market's own words — "artisanal bakery",
   *  "D2C running shoes". Broader than the Brand Kit's `category`, which is a
   *  taxonomy slot; this is the phrase a trend query is actually built from. */
  industry: z.string().max(200).nullable(),
  /** Trading area for trend scoping, e.g. "Jaipur, India". Defaults from the
   *  Brand Kit's `location` but can be widened — a Jaipur shop may market to
   *  all of North India. */
  location: z.string().max(200).nullable(),
  /** Richer than the Brand Kit's one-line `audience`: age, interests, buying
   *  behaviour, whatever the user or the website told us. */
  audience: z.string().max(2000).nullable(),
  /** What the brand is trying to achieve, most important first. Drives which
   *  opportunities score well — "drive footfall" and "build awareness" pull
   *  toward different content. */
  goals: z.array(z.string().min(1).max(300)).max(10).default([]),
  competitors: z.array(brandCompetitorSchema).max(20).default([]),
  /** The one-sentence claim that separates this brand from the competitors
   *  above. Optional: many brands cannot articulate it, and a guessed one is
   *  worse than none. */
  positioning: z.string().max(1000).nullable(),
  /** Recurring themes the brand posts about, e.g. ['behind the scenes',
   *  'customer stories']. Keeps an autonomous run from drifting into topics
   *  the brand has never touched. */
  contentPillars: z.array(z.string().min(1).max(200)).max(12).default([]),
  /** Anything that does not fit the fields above, passed to agents as-is. */
  notes: z.string().max(4000).nullable(),
  source: contextSourceSchema,
  /** Set when a human reviews the context screen and accepts it. Until then
   *  the website importer may still fill blanks; afterwards it will not. */
  confirmedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BrandContext = z.infer<typeof brandContextSchema>;

/** `partialForUpdate` rather than `.partial()`: `goals`, `competitors` and
 *  `contentPillars` all carry `.default([])`, and a plain partial would deliver
 *  those empty arrays on every PATCH — editing only `notes` would wipe them. */
export const updateBrandContextSchema = partialForUpdate(
  brandContextSchema.omit({
    id: true,
    brandId: true,
    source: true,
    confirmedAt: true,
    createdAt: true,
    updatedAt: true,
  }),
).extend({
  /** Sent by the review screen's confirm action. Marks the context as
   *  human-owned, which locks the website importer out of it. */
  confirm: z.boolean().optional(),
});
export type UpdateBrandContextInput = z.infer<typeof updateBrandContextSchema>;

// ---------------------------------------------------------------------------
// Brand preferences (learned facts)
// ---------------------------------------------------------------------------

export const preferenceTypeSchema = z.enum([
  /** Which output format earns engagement — reel over static post, etc. */
  'content_format',
  /** When this audience is actually awake and buying. */
  'posting_time',
  /** Which visual direction performs: product-hero vs lifestyle, etc. */
  'visual_style',
  /** Which register lands — educational, playful, promotional. */
  'tone',
  /** Which subjects earn engagement, and which fall flat. */
  'topic',
]);
export type PreferenceType = z.infer<typeof preferenceTypeSchema>;

/** The learning itself. Free-form per type, but every one carries a `summary`
 *  because that is the string the prompts and the insights screen use — the
 *  structured half is for charts and future re-scoring. */
export const preferenceValueSchema = z
  .object({
    /** One sentence, phrased as a finding: "Reels outperform static posts by
     *  34% on reach." */
    summary: z.string().min(1).max(500),
    /** The value being recommended, when there is a discrete one — 'reel',
     *  '19:00', 'educational'. Lets a generation request act on it directly
     *  instead of parsing prose. */
    value: z.string().max(200).optional(),
    /** Observed effect size, as a percentage delta against the baseline. */
    deltaPercent: z.number().optional(),
    /** How many posts the finding rests on. One post is an anecdote. */
    sampleSize: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type PreferenceValue = z.infer<typeof preferenceValueSchema>;

export const brandPreferenceSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  preferenceType: preferenceTypeSchema,
  preference: preferenceValueSchema,
  /** 0-1. How much to trust this finding — a two-post sample scores low even
   *  when the delta is large. Consumers filter on it; nothing is deleted. */
  confidence: z.number().min(0).max(1),
  /** The scheduled post whose performance produced this learning. Null for a
   *  preference the user stated directly rather than one we measured. */
  learnedFrom: entityIdSchema.nullable(),
  createdAt: z.coerce.date(),
});
export type BrandPreference = z.infer<typeof brandPreferenceSchema>;

export const recordPreferenceSchema = z.object({
  preferenceType: preferenceTypeSchema,
  preference: preferenceValueSchema,
  confidence: z.number().min(0).max(1),
  learnedFrom: entityIdSchema.nullish(),
});
export type RecordPreferenceInput = z.infer<typeof recordPreferenceSchema>;

// ---------------------------------------------------------------------------
// Automation settings (permissions)
// ---------------------------------------------------------------------------

export const trendFrequencySchema = z.enum(['daily', 'three_days', 'weekly']);
export type TrendFrequency = z.infer<typeof trendFrequencySchema>;

/** How far the platform may go before it needs a human.
 *  - `assist`         — propose only; a person triggers every generation.
 *  - `semi_automatic` — generate and QA automatically, hold before publishing.
 *  - `full_autopilot` — research through publish, unattended. */
export const approvalPolicySchema = z.enum(['assist', 'semi_automatic', 'full_autopilot']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const automationSettingsSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  trendFrequency: trendFrequencySchema,
  lastResearchAt: z.coerce.date().nullable(),
  /** When the scheduler should next pick this brand up. Stored rather than
   *  derived so the scheduler's "who is due" query is an indexed range scan
   *  instead of a per-row computation. */
  nextResearchAt: z.coerce.date().nullable(),
  /** The master switch. Off means the scheduler skips the brand entirely,
   *  whatever `approvalPolicy` says. */
  contentAutomationEnabled: z.boolean(),
  /** Publishing without a human. Only meaningful under `full_autopilot`; kept
   *  separate so turning autopilot on does not silently grant posting rights. */
  autoPublishEnabled: z.boolean(),
  approvalPolicy: approvalPolicySchema,
  /** Opt-in gate for the Trend Opportunity Engine's auto-trigger step — see
   *  the same field's doc comment on the `automation_settings` table.
   *  Deliberately separate from `contentAutomationEnabled`: it spends real
   *  generation cost unprompted, so turning on scheduled research does not
   *  silently turn this on too. */
  autoTriggerHighScoreOpportunities: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;

export const updateAutomationSettingsSchema = z
  .object({
    trendFrequency: trendFrequencySchema,
    contentAutomationEnabled: z.boolean(),
    autoPublishEnabled: z.boolean(),
    approvalPolicy: approvalPolicySchema,
    autoTriggerHighScoreOpportunities: z.boolean(),
  })
  .partial();
export type UpdateAutomationSettingsInput = z.infer<typeof updateAutomationSettingsSchema>;

/** Hours between research runs, by cadence. One place, because the scheduler
 *  and the "next research in..." display must agree. */
export const TREND_FREQUENCY_HOURS: Record<TrendFrequency, number> = {
  daily: 24,
  three_days: 72,
  weekly: 168,
};

/**
 * When research should next run.
 *
 * Pure, and exported rather than buried in the service, because the scheduler
 * (Phase 2) and the settings screen both need the same answer and a drift
 * between them shows up as a brand that never gets picked up.
 *
 * A brand that has never been researched is due immediately — a user who
 * switches automation on expects something to happen, not to wait a day.
 */
export function nextResearchAt(
  frequency: TrendFrequency,
  lastResearchAt: Date | null,
  now: Date = new Date(),
): Date {
  if (!lastResearchAt) return now;
  const next = new Date(lastResearchAt.getTime() + TREND_FREQUENCY_HOURS[frequency] * 3_600_000);
  // A cadence that was lengthened while overdue, or a brand paused for a week,
  // would otherwise schedule into the past and fire on the scheduler's next
  // tick anyway. Say so explicitly instead of leaving a stale timestamp the
  // settings screen would render as "due 3 days ago".
  return next.getTime() < now.getTime() ? now : next;
}

// ---------------------------------------------------------------------------
// Context snapshots (what an agent was told)
// ---------------------------------------------------------------------------

export const agentTypeSchema = z.enum([
  'trend',
  'intelligence',
  'strategy',
  'content',
  'performance',
]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const contextSnapshotSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  agentType: agentTypeSchema,
  /** The exact projection handed to the agent. Stored verbatim: when a run
   *  produces something odd, the first question is always what the model was
   *  actually told, and re-deriving it later gives today's context, not the
   *  one that ran. */
  snapshot: z.record(z.string(), z.unknown()),
  usedInJobId: entityIdSchema.nullable(),
  createdAt: z.coerce.date(),
});
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

// ---------------------------------------------------------------------------
// The assembled view
// ---------------------------------------------------------------------------

/**
 * One brand's Brand Brain, condensed for a list.
 *
 * The account-wide "what does the platform actually know about us?" view. Not
 * `FullBrandContext[]` — that carries every product and the whole website
 * reading per brand, which is a lot of payload for a screen that shows a card
 * each. Counts stand in for the collections; tapping through loads the rest.
 */
export interface BrandContextSummary {
  brandId: string;
  brandName: string;
  logoUrl: string | null;
  colors: string[];
  industry: string | null;
  location: string | null;
  audience: string | null;
  goals: string[];
  competitors: BrandCompetitor[];
  positioning: string | null;
  contentPillars: string[];
  notes: string | null;
  source: ContextSource;
  confirmedAt: Date | null;
  productCount: number;
  /** Learnings recorded so far. Zero until Phase 5's analyzer runs — an honest
   *  zero, not a placeholder. */
  preferenceCount: number;
  /** Whether an *applied* website import is feeding this brand's context. */
  hasWebsiteContext: boolean;
  automation: {
    contentAutomationEnabled: boolean;
    trendFrequency: TrendFrequency;
    approvalPolicy: ApprovalPolicy;
    lastResearchAt: Date | null;
    nextResearchAt: Date | null;
  };
  /** 0-100, from `contextCompleteness`. The list's headline number: which
   *  brands the platform actually understands well enough to act for. */
  completeness: number;
}

/** The fields that count toward a complete Brand Brain, and what each is worth.
 *  Weighted rather than a flat field count: knowing the industry shapes every
 *  downstream prompt, whereas free-text notes are a nice-to-have. */
export const CONTEXT_COMPLETENESS_WEIGHTS = {
  industry: 20,
  audience: 20,
  goals: 15,
  location: 10,
  competitors: 10,
  positioning: 10,
  contentPillars: 10,
  products: 5,
} as const;

/**
 * How much of a brand's context is filled in, 0-100.
 *
 * Exported and pure so the API and any future screen compute the same number.
 * Deliberately not stored: it is a function of columns that change constantly,
 * and a cached score that disagrees with the visible fields is worse than no
 * score at all.
 */
export function contextCompleteness(input: {
  industry: string | null;
  location: string | null;
  audience: string | null;
  goals: string[];
  competitors: unknown[];
  positioning: string | null;
  contentPillars: string[];
  productCount: number;
}): number {
  const w = CONTEXT_COMPLETENESS_WEIGHTS;
  let score = 0;
  if (input.industry?.trim()) score += w.industry;
  if (input.audience?.trim()) score += w.audience;
  if (input.goals.length > 0) score += w.goals;
  if (input.location?.trim()) score += w.location;
  if (input.competitors.length > 0) score += w.competitors;
  if (input.positioning?.trim()) score += w.positioning;
  if (input.contentPillars.length > 0) score += w.contentPillars;
  if (input.productCount > 0) score += w.products;
  return score;
}

/**
 * Everything known about a brand, in one object.
 *
 * What `buildFullBrandContext` returns and what the Brand Brain screen renders.
 * Agents get a narrower projection (`getContextForAgent`) — a trend query does
 * not need the colour palette, and every unused field is prompt budget spent
 * on nothing.
 */
export interface FullBrandContext {
  brand: {
    id: string;
    name: string;
    logoUrl: string | null;
    colors: string[];
    tone: string[];
    category: string | null;
    audience: string | null;
    location: string | null;
    languages: string[];
    platforms: string[];
    bannedTopics: string[];
    websiteUrl: string | null;
    socialHandles: Record<string, string>;
  };
  context: BrandContext | null;
  /** The website reading, when one was imported *and* applied. An unapplied
   *  import is deliberately invisible here — same rule the image pipeline
   *  follows, so context and creatives never disagree about it. */
  site: {
    sourceUrl: string;
    visualIdentity: string;
    voiceSummary: string;
    messagingThemes: string[];
    appliedAt: Date;
  } | null;
  products: Array<{
    id: string;
    name: string;
    description: string | null;
    priceMinor: number | null;
    currency: string;
    sellingPoints: string[];
  }>;
  /** Most confident learning per type, not the whole history. */
  preferences: BrandPreference[];
  automation: AutomationSettings | null;
}
