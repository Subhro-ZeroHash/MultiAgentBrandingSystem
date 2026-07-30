import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
// Type-only, same reasoning as the site-profile jsonb columns in core.ts: the
// schema file stays free of runtime imports, but the payloads are worth typing
// against the contract that validates them.
import type { TrendScore, TrendSource, TrendSuggestedRequest } from '@bmas/shared';
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

export const trendIdeas = content.table(
  'trend_ideas',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => trendResearchRuns.id, { onDelete: 'cascade' }),
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
    /** Cross-checked against the run's actual search results before storage;
     *  a citation that didn't survive that check is dropped, not stored. */
    sources: jsonb('sources').$type<TrendSource[]>().notNull().default([]),
    /** Prefills a generation request when the user acts on this idea.
     *  Missing brandId/productId on purpose — the app fills those in once the
     *  user picks a product, and every field here stays user-editable. */
    suggestedRequest: jsonb('suggested_request').$type<TrendSuggestedRequest>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('trend_ideas_run_idx').on(t.runId)],
);

export const trendResearchRunsRelations = relations(trendResearchRuns, ({ one, many }) => ({
  brand: one(brands, { fields: [trendResearchRuns.brandId], references: [brands.id] }),
  ideas: many(trendIdeas),
}));

export const trendIdeasRelations = relations(trendIdeas, ({ one }) => ({
  run: one(trendResearchRuns, { fields: [trendIdeas.runId], references: [trendResearchRuns.id] }),
}));

export type TrendResearchRunRow = typeof trendResearchRuns.$inferSelect;
export type NewTrendResearchRunRow = typeof trendResearchRuns.$inferInsert;
export type TrendIdeaRow = typeof trendIdeas.$inferSelect;
export type NewTrendIdeaRow = typeof trendIdeas.$inferInsert;

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
