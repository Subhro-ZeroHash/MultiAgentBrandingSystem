import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
// Type-only, same reasoning as the site-profile jsonb columns in core.ts: the
// schema file stays free of runtime imports, but the payloads are worth typing
// against the contract that validates them.
import type {
  BrandCompetitor,
  IntelligenceScore,
  PreferenceValue,
  TrendScore,
  TrendSource,
  TrendSuggestedRequest,
} from '@bmas/shared';
import { brands, users } from './core.js';

/** Owned by the content-generation workstream. */
export const content = pgSchema('content');

export const jobStatus = content.enum('job_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const campaignType = content.enum('campaign_type', [
  'offer',
  'launch',
  'festival',
  'generic',
]);

export const outputFormat = content.enum('output_format', [
  'instagram_post',
  'story_reel_cover',
  'facebook_banner',
  'poster_a4',
]);

/** Mirrors `styleTemplateSchema` in @bmas/shared — the two must stay in step,
 *  or a request the API accepts fails on insert. */
export const styleTemplate = content.enum('style_template', [
  'festive',
  'minimal_luxury',
  'bold_discount',
  'flat_lay_product_hero',
  'studio_white',
  'lifestyle_in_use',
  'bold_typographic',
  'tech_dark_gradient',
  'neon_gaming',
  'outdoor_natural_light',
  'vintage_retro',
  'playful_pastel',
]);

export const products = content.table(
  'products',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** Minor units (paise/cents) to avoid float money. */
    priceMinor: integer('price_minor'),
    currency: text('currency').notNull().default('INR'),
    /** Short, concrete claims the brief and copy stages can lean on directly
     *  ("Pure silk", "Handwoven") instead of inferring them from `description`. */
    sellingPoints: jsonb('selling_points').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('products_brand_idx').on(t.brandId)],
);

export const productImages = content.table(
  'product_images',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    /** Background-removed variant produced by the asset-prep step (FR-3.6). */
    cleanedStorageKey: text('cleaned_storage_key'),
    width: integer('width'),
    height: integer('height'),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('product_images_product_idx').on(t.productId)],
);

export const generationJobs = content.table(
  'generation_jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** Client-supplied key making retries safe (NFR: reliability). */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: jobStatus('status').notNull().default('queued'),
    stage: text('stage'),
    campaignType: campaignType('campaign_type').notNull(),
    styleTemplate: styleTemplate('style_template').notNull(),
    outputFormat: outputFormat('output_format').notNull(),
    /** The validated CreativeRequest, stored verbatim so a job can be replayed. */
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('generation_jobs_brand_created_idx').on(t.brandId, t.createdAt),
    index('generation_jobs_status_idx').on(t.status),
  ],
);

/** Which extra knowledge source shaped this variant's brief, when the
 *  generation ran in 'diverse' mode (see `creativeRequestSchema.variantMode`
 *  in @bmas/shared). Null for uniform-mode jobs (today's single-prompt path,
 *  e.g. every scheduled-campaign generation) — there is no "kind" to record. */
export const variantKind = content.enum('variant_kind', ['trend', 'website', 'clean']);

export const creativeAssets = content.table(
  'creative_assets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    jobId: text('job_id')
      .notNull()
      .references(() => generationJobs.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    thumbnailStorageKey: text('thumbnail_storage_key'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** Set when the user picks this variant out of the fan-out. */
    isSelected: boolean('is_selected').notNull().default(false),
    /** Vision-QA readback (FR-3.5). Null until the QA stage runs. */
    qaResult: jsonb('qa_result').$type<Record<string, unknown>>(),
    /** Ordered natural-language edits applied to this asset (FR-3.3). Carried
     *  forward (parent's edits + this one) onto every row an edit produces, so
     *  the current tip's history doesn't require walking `asset_edits`. */
    edits: jsonb('edits').$type<Array<{ instruction: string; at: string }>>().notNull().default([]),
    variantKind: variantKind('variant_kind'),
    /** Null on an original/slot asset. Set to that original asset's own id on
     *  every row an edit produces — never to the immediately-prior edit — so
     *  "every version of this slot" and "cap this slot's edit count" are both
     *  a flat `where root_asset_id = :root` instead of walking a chain.
     *  Self-referencing, hence the `AnyPgColumn` return type. */
    rootAssetId: text('root_asset_id').references((): AnyPgColumn => creativeAssets.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('creative_assets_job_idx').on(t.jobId),
    index('creative_assets_root_idx').on(t.rootAssetId),
  ],
);

export const assetEditStatus = content.enum('asset_edit_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

/**
 * One user-initiated "Regenerate" attempt on a creative asset (FR-3.3). Kept
 * separate from `creative_assets` rather than adding in-flight/failure state
 * to it directly — `creative_assets` stays "only ever contains a real,
 * viewable image"; this is the append-only attempt log, including attempts
 * that failed and produced nothing. That split is also what makes the
 * regeneration cap a plain `count(*)` rather than reasoning about partial
 * rows on the assets table.
 */
export const assetEdits = content.table(
  'asset_edits',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** The slot this attempt counts against — always the original asset,
     *  never a prior edit's result (see `creativeAssets.rootAssetId`). */
    rootAssetId: text('root_asset_id')
      .notNull()
      .references(() => creativeAssets.id, { onDelete: 'cascade' }),
    /** What actually got fed to `.edit()` for this attempt — the current tip
     *  at the moment the user hit Regenerate, giving progressive chaining
     *  (edit #2 edits edit #1's result, not the pristine original). */
    sourceAssetId: text('source_asset_id')
      .notNull()
      .references(() => creativeAssets.id, { onDelete: 'cascade' }),
    instruction: text('instruction').notNull(),
    status: assetEditStatus('status').notNull().default('queued'),
    /** Set only once the edit succeeds. */
    resultAssetId: text('result_asset_id').references(() => creativeAssets.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('asset_edits_root_idx').on(t.rootAssetId),
    // Closes a check-then-insert race in `regenerateAsset`: two requests for
    // the same slot arriving close enough together could both read the same
    // "not already in flight" count before either commits, both pass, and
    // both insert — bypassing the 2-attempt cap the whole feature exists to
    // enforce. A partial unique index makes "at most one active attempt per
    // slot" true at the database level regardless of timing; the loser gets a
    // unique-violation the service maps back to the same 400 the read-based
    // check already returns for the non-racing case.
    uniqueIndex('asset_edits_one_active_per_root_idx')
      .on(t.rootAssetId)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export const copyPacks = content.table(
  'copy_packs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    jobId: text('job_id')
      .notNull()
      .references(() => generationJobs.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    language: text('language').notNull().default('en'),
    headline: text('headline').notNull(),
    caption: text('caption').notNull(),
    hashtags: jsonb('hashtags').$type<string[]>().notNull().default([]),
    cta: text('cta').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('copy_packs_job_idx').on(t.jobId)],
);

/** Append-only credit ledger; balance is the sum, never a mutable column. */
export const creditLedger = content.table(
  'credit_ledger',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Positive on grant/top-up, negative on spend. */
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    jobId: text('job_id').references(() => generationJobs.id, { onDelete: 'set null' }),
    /** Payment provider reference for top-ups. */
    externalRef: text('external_ref'),
    balanceAfter: bigint('balance_after', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_ledger_user_created_idx').on(t.userId, t.createdAt)],
);

export const productsRelations = relations(products, ({ one, many }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  images: many(productImages),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, { fields: [productImages.productId], references: [products.id] }),
}));

export const generationJobsRelations = relations(generationJobs, ({ one, many }) => ({
  brand: one(brands, { fields: [generationJobs.brandId], references: [brands.id] }),
  product: one(products, { fields: [generationJobs.productId], references: [products.id] }),
  assets: many(creativeAssets),
  copy: many(copyPacks),
}));

export const creativeAssetsRelations = relations(creativeAssets, ({ one, many }) => ({
  job: one(generationJobs, { fields: [creativeAssets.jobId], references: [generationJobs.id] }),
  root: one(creativeAssets, {
    fields: [creativeAssets.rootAssetId],
    references: [creativeAssets.id],
    relationName: 'assetLineage',
  }),
  edits: many(assetEdits, { relationName: 'editsBySource' }),
}));

export const assetEditsRelations = relations(assetEdits, ({ one }) => ({
  root: one(creativeAssets, {
    fields: [assetEdits.rootAssetId],
    references: [creativeAssets.id],
    relationName: 'editsByRoot',
  }),
  source: one(creativeAssets, {
    fields: [assetEdits.sourceAssetId],
    references: [creativeAssets.id],
    relationName: 'editsBySource',
  }),
  result: one(creativeAssets, {
    fields: [assetEdits.resultAssetId],
    references: [creativeAssets.id],
    relationName: 'editsByResult',
  }),
}));

export const socialPlatform = content.enum('social_platform', [
  'instagram',
  'facebook',
]);

export const socialAccountStatus = content.enum('social_account_status', [
  'active',
  'token_expired',
  'revoked',
]);

export const socialAccounts = content.table(
  'social_accounts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: socialPlatform('platform').notNull(),
    /** Facebook Page that owns the account. Null under Instagram Login, where
     *  the Instagram account authenticates directly and no Page is involved. */
    pageId: text('page_id'),
    igBusinessId: text('ig_business_id'),
    /** Encrypted at rest with AES-256-GCM. 256-byte strings after encryption. */
    pageAccessToken: text('page_access_token').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }).notNull(),
    displayName: text('display_name').notNull(),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
    status: socialAccountStatus('status').notNull().default('active'),
  },
  (t) => [
    index('social_accounts_owner_platform_idx').on(t.ownerId, t.platform),
    index('social_accounts_status_expires_idx').on(t.status, t.tokenExpiresAt),
    // Reconnecting an account already linked must refresh the stored token
    // rather than add a second identical row, which would show the same handle
    // twice in the picker and leave a stale token behind on disconnect.
    uniqueIndex('social_accounts_owner_platform_account_idx').on(
      t.ownerId,
      t.platform,
      t.igBusinessId,
    ),
  ],
);

export const socialAccountsRelations = relations(socialAccounts, ({ one }) => ({
  owner: one(users, { fields: [socialAccounts.ownerId], references: [users.id] }),
}));

export const scheduledCampaignStatus = content.enum('scheduled_campaign_status', [
  'active',
  /** Stops future posts without discarding the campaign: queued publish jobs
   *  are removed and pending posts held, so resuming can re-queue them. */
  'paused',
  'completed',
  'cancelled',
]);

export const scheduledPostStatus = content.enum('scheduled_post_status', [
  'pending_generation',
  'pending_approval',
  'approved',
  /** Claimed by a publish worker and in flight with Meta. Exists so claiming is
   *  a single conditional UPDATE: without a state between 'approved' and
   *  'posted', a job redelivered mid-publish (BullMQ retries a stalled job
   *  once) would still see 'approved' and publish the same creative twice. */
  'publishing',
  'rejected',
  'posted',
  'failed',
  'expired',
]);

/** One "give me source material once, post N times over M days" request. Each
 *  planned post is a row in `scheduled_posts`, generated ahead of its slot and
 *  gated on user approval before it can publish. */
export const scheduledCampaigns = content.table(
  'scheduled_campaigns',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    campaignType: campaignType('campaign_type').notNull(),
    styleTemplate: styleTemplate('style_template').notNull(),
    outputFormat: outputFormat('output_format').notNull(),
    totalDays: integer('total_days').notNull(),
    postsPerDay: integer('posts_per_day').notNull(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    status: scheduledCampaignStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scheduled_campaigns_brand_created_idx').on(t.brandId, t.createdAt)],
);

export const scheduledPosts = content.table(
  'scheduled_posts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => scheduledCampaigns.id, { onDelete: 'cascade' }),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: scheduledPostStatus('status').notNull().default('pending_generation'),
    /** Unique because the generation-complete hooks resolve a job back to
     *  exactly one scheduled post; two rows sharing a job would leave one
     *  silently stuck in 'pending_generation' forever. */
    generationJobId: text('generation_job_id').references(() => generationJobs.id, {
      onDelete: 'set null',
    }),
    /** The variant picked for this slot — defaulted when generation completes,
     *  overridable by the user at approval time. */
    selectedAssetId: text('selected_asset_id').references(() => creativeAssets.id, {
      onDelete: 'set null',
    }),
    accountId: text('account_id').references(() => socialAccounts.id, { onDelete: 'set null' }),
    caption: text('caption'),
    /** Meta's post id, once published. */
    igMediaId: text('ig_media_id'),
    error: text('error'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('scheduled_posts_brand_scheduled_idx').on(t.brandId, t.scheduledFor),
    index('scheduled_posts_campaign_idx').on(t.campaignId),
    index('scheduled_posts_status_idx').on(t.status),
    uniqueIndex('scheduled_posts_generation_job_idx').on(t.generationJobId),
  ],
);

export const scheduledCampaignsRelations = relations(scheduledCampaigns, ({ one, many }) => ({
  brand: one(brands, { fields: [scheduledCampaigns.brandId], references: [brands.id] }),
  product: one(products, { fields: [scheduledCampaigns.productId], references: [products.id] }),
  posts: many(scheduledPosts),
}));

export const scheduledPostsRelations = relations(scheduledPosts, ({ one }) => ({
  campaign: one(scheduledCampaigns, {
    fields: [scheduledPosts.campaignId],
    references: [scheduledCampaigns.id],
  }),
  generationJob: one(generationJobs, {
    fields: [scheduledPosts.generationJobId],
    references: [generationJobs.id],
  }),
  selectedAsset: one(creativeAssets, {
    fields: [scheduledPosts.selectedAssetId],
    references: [creativeAssets.id],
  }),
  account: one(socialAccounts, {
    fields: [scheduledPosts.accountId],
    references: [socialAccounts.id],
  }),
}));

/** One Expo push token per device registration; upserted so re-registering the
 *  same device (reinstall, token refresh) doesn't accumulate duplicates. */
export const pushTokens = content.table(
  'push_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expoPushToken: text('expo_push_token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('push_tokens_owner_idx').on(t.ownerId),
    uniqueIndex('push_tokens_token_idx').on(t.expoPushToken),
  ],
);

export const trendResearchStatus = content.enum('trend_research_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const trendCategory = content.enum('trend_category', [
  'industry_topic',
  'event_festival',
  /** Approximated via a search-grounded query — no dedicated API exposes real
   *  trending-hashtag/audio data short of a paid social-listening contract. */
  'social_trend',
]);

export const trendContentType = content.enum('trend_content_type', [
  'post',
  'reel',
  'story',
  'campaign',
]);

/** What the user did with an opportunity once it was shown. Mutated in
 *  place, not append-only — a run's opportunities have one current state
 *  each, not a history of states. The append-only side of "ignored"/"worked
 *  on" is a row in `brand_preferences`, written once via
 *  `recordFeedbackSignal` when the status changes — this column is UI
 *  state, that table is memory. */
export const trendOpportunityStatus = content.enum('trend_opportunity_status', [
  'new',
  'saved',
  'ignored',
  'working_on',
]);

/** One "Find Trending Content Ideas" click. Kept separate from
 *  `generation_jobs` — researching is a distinct step upstream of generation,
 *  and a run may never lead to a generation at all if nothing surfaced fits. */
export const trendResearchRuns = content.table(
  'trend_research_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    status: trendResearchStatus('status').notNull().default('queued'),
    /** What the run actually searched for, echoed back for the history view. */
    locationOverride: text('location_override'),
    focus: text('focus'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trend_research_runs_brand_created_idx').on(t.brandId, t.createdAt),
    index('trend_research_runs_status_idx').on(t.status),
  ],
);

/**
 * Raw evidence, one row per search-provider result — the layer that exists
 * independently of any AI judgment. See the header of
 * `packages/shared/src/content/trends.ts` for the full reasoning: storing
 * only a synthesized "idea" means every past judgment is a black box; storing
 * the signals it was built from means the evidence outlives the model call
 * that interpreted it.
 *
 * `source` and `signalType` are `text`, not enums, on purpose — adding a
 * provider (Bing, Reddit, a paid social-listening contract) later is new rows
 * under this same shape, not a migration. `SignalSource`/`SignalType` in
 * @bmas/shared are where that vocabulary actually lives and grows.
 */
export const trendSignals = content.table(
  'trend_signals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => trendResearchRuns.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    signalType: text('signal_type').notNull(),
    /** Null until synthesis clusters this signal under a canonical name.
     *  Several signals share one topic once clustered. */
    topic: text('topic'),
    title: text('title').notNull(),
    snippet: text('snippet').notNull(),
    /** 0-100. How prominent this one piece of evidence is on its own — not
     *  brand relevance, which is judged once at the opportunity level. */
    strength: real('strength').notNull(),
    sourceUrl: text('source_url').notNull(),
    publishedAt: text('published_at'),
    /** Set once synthesis clusters this signal into an opportunity. Stays
     *  null forever for a signal judged too weak/irrelevant to cluster —
     *  that is a legitimate outcome, not a bug. `ON DELETE SET NULL`: the
     *  raw evidence outlives the opportunity it once fed, matching
     *  `brand_preferences.learned_from`'s reasoning — deleting a conclusion
     *  should not erase the evidence that produced it. */
    opportunityId: text('opportunity_id').references((): AnyPgColumn => trendOpportunities.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trend_signals_run_idx').on(t.runId),
    index('trend_signals_opportunity_idx').on(t.opportunityId),
  ],
);

/** The AI's conclusion after clustering related signals and judging them
 *  against the brand — what "Trend Alerts" actually shows. Replaces the
 *  single-layer `trend_ideas` model: everything below `signalCount` used to
 *  live directly off one search call, now lives off a clustered set of
 *  `trend_signals` rows this table's id is the parent of. */
export const trendOpportunities = content.table(
  'trend_opportunities',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => trendResearchRuns.id, { onDelete: 'cascade' }),
    /** Canonical cluster name, matching the `topic` written onto every
     *  signal feeding this opportunity. */
    topic: text('topic').notNull(),
    category: trendCategory('category').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    /** The concrete instruction, phrased as one — "Create a Diwali
     *  promotional post using the 20%-off angle" — not a description. */
    recommendation: text('recommendation').notNull(),
    contentType: trendContentType('content_type').notNull(),
    /** The five model-judged axes plus the computed `overall` ranking number.
     *  `overall` is never asked of the model directly — see
     *  computeTrendScore in @bmas/shared. */
    score: jsonb('score').$type<TrendScore>().notNull(),
    /** Denormalized count of signals clustered into this opportunity —
     *  "supported by 5 signals" without a join on every feed read. */
    signalCount: integer('signal_count').notNull(),
    /** Cross-checked against the run's actual search results before storage;
     *  a citation that didn't survive that check is dropped, not stored. */
    sources: jsonb('sources').$type<TrendSource[]>().notNull().default([]),
    /** Prefills a generation request when the user acts on this opportunity.
     *  Missing brandId/productId on purpose — the app fills those in once
     *  the user picks a product, and every field here stays user-editable. */
    suggestedRequest: jsonb('suggested_request').$type<TrendSuggestedRequest>().notNull(),
    status: trendOpportunityStatus('status').notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('trend_opportunities_run_idx').on(t.runId)],
);

export const trendResearchRunsRelations = relations(trendResearchRuns, ({ one, many }) => ({
  brand: one(brands, { fields: [trendResearchRuns.brandId], references: [brands.id] }),
  signals: many(trendSignals),
  opportunities: many(trendOpportunities),
}));

export const trendSignalsRelations = relations(trendSignals, ({ one }) => ({
  run: one(trendResearchRuns, { fields: [trendSignals.runId], references: [trendResearchRuns.id] }),
  opportunity: one(trendOpportunities, {
    fields: [trendSignals.opportunityId],
    references: [trendOpportunities.id],
  }),
}));

export const trendOpportunitiesRelations = relations(trendOpportunities, ({ one, many }) => ({
  run: one(trendResearchRuns, {
    fields: [trendOpportunities.runId],
    references: [trendResearchRuns.id],
  }),
  signals: many(trendSignals),
}));

// ---------------------------------------------------------------------------
// Brand Brain
//
// Persistent per-brand understanding, read by every agent in the autonomous
// loop. Split across four tables because the four kinds of knowledge change on
// unrelated clocks and have unrelated write patterns — see the header of
// packages/shared/src/content/brand-context.ts for the full reasoning.
//
// `content` rather than `core`: GEO reads the Brand Kit, but none of this. A
// core change needs both workstream owners (CLAUDE.md rule 4).
// ---------------------------------------------------------------------------

export const contextSource = content.enum('context_source', ['manual', 'website', 'inferred']);

/**
 * What the brand says about itself, beyond the Brand Kit (1.1).
 *
 * One row per brand, created alongside the brand so every downstream reader can
 * assume it exists. Mostly nullable on purpose: a brand created in ten seconds
 * from a name and two colours has none of this yet, and the website importer
 * fills what it can afterwards.
 */
export const brandContexts = content.table(
  'brand_contexts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** The market's phrase for this business, e.g. "artisanal bakery" —
     *  broader than the Brand Kit's taxonomy `category`, and what a trend
     *  query is actually built from. */
    industry: text('industry'),
    /** Trading area for trend scoping. Seeded from the Brand Kit's location,
     *  but widened independently — a Jaipur shop may market to North India. */
    location: text('location'),
    audience: text('audience'),
    goals: jsonb('goals').$type<string[]>().notNull().default([]),
    competitors: jsonb('competitors').$type<BrandCompetitor[]>().notNull().default([]),
    positioning: text('positioning'),
    /** Themes the brand actually posts about — the guardrail that keeps an
     *  unattended run from drifting into subjects it has never touched. */
    contentPillars: jsonb('content_pillars').$type<string[]>().notNull().default([]),
    notes: text('notes'),
    source: contextSource('source').notNull().default('manual'),
    /** Set when a human reviews and accepts the context. Until then the
     *  website importer may fill blanks; afterwards it leaves the row alone,
     *  so a re-import cannot quietly undo someone's corrections. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brand_contexts_brand_idx').on(t.brandId)],
);

export const preferenceType = content.enum('preference_type', [
  'content_format',
  'posting_time',
  'visual_style',
  'tone',
  'topic',
]);

/**
 * What the platform has learned about this brand's audience (1.2).
 *
 * Append-only, and never updated in place: a learning is an observation made at
 * a moment from a sample, and the sequence is the interesting part — "reels win"
 * arrived at 0.3 confidence in May and 0.9 in July is a different fact from
 * "reels win, 0.9". Consumers read the top row per type; nothing is deleted,
 * so a superseded finding stays auditable.
 */
export const brandPreferences = content.table(
  'brand_preferences',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    preferenceType: preferenceType('preference_type').notNull(),
    preference: jsonb('preference').$type<PreferenceValue>().notNull(),
    /** 0-1. Two posts is an anecdote however large the delta, so consumers
     *  filter on this rather than treating every row as equally true. */
    confidence: real('confidence').notNull(),
    /** The scheduled post whose performance produced this. Null when the user
     *  stated the preference outright instead of us measuring it. Nulled
     *  rather than cascaded — deleting a post should not erase what it taught
     *  us. */
    learnedFrom: text('learned_from').references(() => scheduledPosts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Serves the only two reads there are: "latest per type for this brand"
    // and, by prefix, "everything for this brand".
    index('brand_preferences_brand_type_created_idx').on(t.brandId, t.preferenceType, t.createdAt),
    // Not for any query — for the `ON DELETE SET NULL` on `learned_from`.
    // Without it, deleting a scheduled post sequentially scans this table to
    // find referencing rows, and this is the fastest-growing table in the
    // system (one row per regeneration, approval and rejection). Cancelling a
    // campaign deletes posts in bulk, so that scan runs once per post.
    index('brand_preferences_learned_from_idx').on(t.learnedFrom),
  ],
);

export const trendFrequency = content.enum('trend_frequency', ['daily', 'three_days', 'weekly']);

export const approvalPolicy = content.enum('approval_policy', [
  'assist',
  'semi_automatic',
  'full_autopilot',
]);

/**
 * How much of the loop this brand lets the platform run unattended (1.3).
 *
 * One row per brand, created with the brand, defaulting to fully manual —
 * automation is opted into, never inherited. The scheduler (Phase 2) reads this
 * table and nothing else to decide what work exists.
 */
export const automationSettings = content.table(
  'automation_settings',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    trendFrequency: trendFrequency('trend_frequency').notNull().default('weekly'),
    lastResearchAt: timestamp('last_research_at', { withTimezone: true }),
    /** Stored rather than derived from `lastResearchAt` + cadence so the
     *  scheduler's "who is due" is an indexed range scan instead of a
     *  computation over every brand. Recomputed on every cadence change and
     *  after every run — see `nextResearchAt` in @bmas/shared, which both this
     *  and the settings screen call so they cannot drift apart. */
    nextResearchAt: timestamp('next_research_at', { withTimezone: true }),
    /** Master switch. Off means the scheduler skips this brand entirely,
     *  whatever `approvalPolicy` says. */
    contentAutomationEnabled: boolean('content_automation_enabled').notNull().default(false),
    /** Separate from `approvalPolicy` so that moving to full autopilot does
     *  not silently grant the right to post to a live Instagram account —
     *  publishing is the one step with no undo. */
    autoPublishEnabled: boolean('auto_publish_enabled').notNull().default(false),
    approvalPolicy: approvalPolicy('approval_policy').notNull().default('assist'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('automation_settings_brand_idx').on(t.brandId),
    // The scheduler's sole query: enabled brands whose next run has come.
    index('automation_settings_due_idx').on(t.contentAutomationEnabled, t.nextResearchAt),
  ],
);

/**
 * The context an agent was actually handed, at one moment (1.4).
 *
 * Append-only forensics. When a run produces something off-brand the first
 * question is what the model was told, and re-deriving it later answers with
 * today's context rather than the one that ran — the brand may have been edited
 * since, which is frequently the explanation.
 */
export const contextSnapshots = content.table(
  'context_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Which agent's projection this is — 'trend' | 'strategy' | 'content' |
     *  'performance'. Text rather than an enum: the agent roster is still
     *  moving, and a snapshot is a log line, not a constraint worth a
     *  migration every time one is added. */
    agentType: text('agent_type').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    usedInJobId: text('used_in_job_id').references(() => generationJobs.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('context_snapshots_brand_created_idx').on(t.brandId, t.createdAt),
    index('context_snapshots_job_idx').on(t.usedInJobId),
  ],
);

export const brandContextsRelations = relations(brandContexts, ({ one }) => ({
  brand: one(brands, { fields: [brandContexts.brandId], references: [brands.id] }),
}));

export const brandPreferencesRelations = relations(brandPreferences, ({ one }) => ({
  brand: one(brands, { fields: [brandPreferences.brandId], references: [brands.id] }),
  source: one(scheduledPosts, {
    fields: [brandPreferences.learnedFrom],
    references: [scheduledPosts.id],
  }),
}));

export const automationSettingsRelations = relations(automationSettings, ({ one }) => ({
  brand: one(brands, { fields: [automationSettings.brandId], references: [brands.id] }),
}));

export const contextSnapshotsRelations = relations(contextSnapshots, ({ one }) => ({
  brand: one(brands, { fields: [contextSnapshots.brandId], references: [brands.id] }),
  job: one(generationJobs, {
    fields: [contextSnapshots.usedInJobId],
    references: [generationJobs.id],
  }),
}));

// ---------------------------------------------------------------------------
// Leads / Business Intelligence
//
// A second research agent, same machinery as Trend Research (search →
// brand-aware judgment → scored, sourced rows) but a different question: not
// "can this become content?" but "should the brand owner know about this?"
// Kept in its own tables rather than folded into trend_research_runs /
// trend_ideas — a policy change and a festival post idea are different kinds
// of thing, and conflating their feeds would bury one under the other rather
// than let each be read as intended.
// ---------------------------------------------------------------------------

export const intelligenceCategory = content.enum('intelligence_category', [
  'government_policy',
  'brand_news',
  'industry_news',
  'competitor',
  'local',
]);

export const intelligenceUrgency = content.enum('intelligence_urgency', [
  'low',
  'medium',
  'high',
]);

export const intelligenceItemStatus = content.enum('intelligence_item_status', [
  'new',
  'read',
  'saved',
  'dismissed',
]);

export const intelligenceRunStatus = content.enum('intelligence_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

/** One "Refresh My Intelligence Feed" run — the leads-side counterpart of
 *  `trend_research_runs`. */
export const intelligenceRuns = content.table(
  'intelligence_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    status: intelligenceRunStatus('status').notNull().default('queued'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('intelligence_runs_brand_created_idx').on(t.brandId, t.createdAt),
    index('intelligence_runs_status_idx').on(t.status),
  ],
);

export const intelligenceItems = content.table(
  'intelligence_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => intelligenceRuns.id, { onDelete: 'cascade' }),
    category: intelligenceCategory('category').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    /** The answer to "so what?" — why this specific brand should care. */
    whyItMatters: text('why_it_matters').notNull(),
    urgency: intelligenceUrgency('urgency').notNull(),
    /** The five model-judged axes plus the computed `overall` ranking number,
     *  same split as `trend_ideas.score` — see computeIntelligenceScore in
     *  @bmas/shared. */
    score: jsonb('score').$type<IntelligenceScore>().notNull(),
    /** Cross-checked against the run's actual search results before storage,
     *  same as trend_ideas.sources. */
    sources: jsonb('sources').$type<TrendSource[]>().notNull().default([]),
    status: intelligenceItemStatus('status').notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('intelligence_items_run_idx').on(t.runId),
    // The feed's own read: this brand's items newest-first, optionally
    // filtered to a category tab. A run's brandId only reaches this table via
    // its parent run, so the feed query joins runs anyway — this index serves
    // the join's inner side.
    index('intelligence_items_run_category_idx').on(t.runId, t.category),
  ],
);

export const intelligenceRunsRelations = relations(intelligenceRuns, ({ one, many }) => ({
  brand: one(brands, { fields: [intelligenceRuns.brandId], references: [brands.id] }),
  items: many(intelligenceItems),
}));

export const intelligenceItemsRelations = relations(intelligenceItems, ({ one }) => ({
  run: one(intelligenceRuns, { fields: [intelligenceItems.runId], references: [intelligenceRuns.id] }),
}));

// ---------------------------------------------------------------------------
// AI Research prompt box
//
// "Ask about your brand..." — a one-off question answered from live search
// plus the same Context Manager output the two research agents use, not a
// third research pipeline. Persisted so the prompt screen can show a history
// of what was asked, the same way trend_research_runs gives the trend screen
// a history.
// ---------------------------------------------------------------------------

export const aiResearchQueries = content.table(
  'ai_research_queries',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    sources: jsonb('sources').$type<TrendSource[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_research_queries_brand_created_idx').on(t.brandId, t.createdAt)],
);

export const aiResearchQueriesRelations = relations(aiResearchQueries, ({ one }) => ({
  brand: one(brands, { fields: [aiResearchQueries.brandId], references: [brands.id] }),
}));

export type IntelligenceRunRow = typeof intelligenceRuns.$inferSelect;
export type NewIntelligenceRunRow = typeof intelligenceRuns.$inferInsert;
export type IntelligenceItemRow = typeof intelligenceItems.$inferSelect;
export type NewIntelligenceItemRow = typeof intelligenceItems.$inferInsert;
export type AiResearchQueryRow = typeof aiResearchQueries.$inferSelect;
export type NewAiResearchQueryRow = typeof aiResearchQueries.$inferInsert;

export type BrandContextRow = typeof brandContexts.$inferSelect;
export type NewBrandContextRow = typeof brandContexts.$inferInsert;
export type BrandPreferenceRow = typeof brandPreferences.$inferSelect;
export type NewBrandPreferenceRow = typeof brandPreferences.$inferInsert;
export type AutomationSettingsRow = typeof automationSettings.$inferSelect;
export type NewAutomationSettingsRow = typeof automationSettings.$inferInsert;
export type ContextSnapshotRow = typeof contextSnapshots.$inferSelect;
export type NewContextSnapshotRow = typeof contextSnapshots.$inferInsert;

export type TrendResearchRunRow = typeof trendResearchRuns.$inferSelect;
export type NewTrendResearchRunRow = typeof trendResearchRuns.$inferInsert;
export type TrendSignalRow = typeof trendSignals.$inferSelect;
export type NewTrendSignalRow = typeof trendSignals.$inferInsert;
export type TrendOpportunityRow = typeof trendOpportunities.$inferSelect;
export type NewTrendOpportunityRow = typeof trendOpportunities.$inferInsert;

export type SocialAccount = typeof socialAccounts.$inferSelect;
export type NewSocialAccount = typeof socialAccounts.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type NewGenerationJob = typeof generationJobs.$inferInsert;
export type CreativeAsset = typeof creativeAssets.$inferSelect;
export type CopyPackRow = typeof copyPacks.$inferSelect;
export type ScheduledCampaign = typeof scheduledCampaigns.$inferSelect;
export type NewScheduledCampaign = typeof scheduledCampaigns.$inferInsert;
export type ScheduledPost = typeof scheduledPosts.$inferSelect;
export type NewScheduledPost = typeof scheduledPosts.$inferInsert;
export type PushToken = typeof pushTokens.$inferSelect;
export type NewPushToken = typeof pushTokens.$inferInsert;
