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
  AutoTriggeredJobRef,
  BrandCompetitor,
  IntelligencePoolScore,
  IntelligenceScore,
  PlanEvidence,
  PreferenceValue,
  TrendPoolScore,
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

/**
 * Video generation's own job/asset pair — deliberately separate tables from
 * `generation_jobs`/`creative_assets` rather than a `mediaType` discriminator
 * bolted onto them. The two media types share almost nothing structurally:
 * an image job carries `campaignType`/`styleTemplate`/`outputFormat` and fans
 * out into diverse-mode variants; a video job has none of that; a video asset
 * has `durationSeconds` where an image asset has none, and no vision-QA
 * readback shape (there is no video-QA equivalent yet). Reusing the image
 * tables would mean every video row carrying a pile of nullable image-only
 * columns and vice versa. New capability, new tables — the existing ones stay
 * exactly as stable as they were.
 *
 * Reuses `jobStatus` rather than declaring an identical enum: it is already
 * exactly queued/running/succeeded/failed/cancelled, and a real second
 * definition would just be the same five strings duplicated for no reason.
 */
export const videoGenerationJobs = content.table(
  'video_generation_jobs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: jobStatus('status').notNull().default('queued'),
    stage: text('stage'),
    /** The validated VideoGenerationRequest, stored verbatim so a job can be
     *  replayed — same reasoning as `generationJobs.request`. */
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('video_generation_jobs_brand_created_idx').on(t.brandId, t.createdAt),
    index('video_generation_jobs_status_idx').on(t.status),
  ],
);

export const videoAssets = content.table(
  'video_assets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    jobId: text('job_id')
      .notNull()
      .references(() => videoGenerationJobs.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    /** Null until the pipeline extracts one — a video needs its own thumbnail
     *  frame the way an image asset's thumbnail is a resize of itself; a video
     *  needs an actual decode step to produce one. */
    thumbnailStorageKey: text('thumbnail_storage_key'),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    durationSeconds: real('duration_seconds').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** Set when the user picks this take. Mirrors `creativeAssets.isSelected`
     *  — kept even though nothing writes multiple takes per job yet, since a
     *  bare boolean costs nothing to have ready for when regeneration/variant
     *  fan-out reaches video the way it already has for images. */
    isSelected: boolean('is_selected').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('video_assets_job_idx').on(t.jobId)],
);

export const videoGenerationJobsRelations = relations(videoGenerationJobs, ({ one, many }) => ({
  brand: one(brands, { fields: [videoGenerationJobs.brandId], references: [brands.id] }),
  product: one(products, { fields: [videoGenerationJobs.productId], references: [products.id] }),
  assets: many(videoAssets),
}));

export const videoAssetsRelations = relations(videoAssets, ({ one }) => ({
  job: one(videoGenerationJobs, {
    fields: [videoAssets.jobId],
    references: [videoGenerationJobs.id],
  }),
}));

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

export const socialPlatform = content.enum('social_platform', ['instagram', 'facebook']);

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

/**
 * One sync attempt's worth of Instagram metrics for one published post.
 * Append-only, same reasoning as `geo.probe_runs`: the sync runs repeatedly
 * over a post's tracked lifetime, and each pull is retained rather than
 * overwritten, so engagement growth over time is visible and a failed pull is
 * data (via `error`) rather than a silent gap. `raw` keeps the full Graph API
 * response so a metric this table doesn't have a column for yet is not lost.
 */
export const postInsights = content.table(
  'post_insights',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /**
     * Nullable: performance is tracked for every post on the connected
     * account, not just the ones this app published. A post made from the
     * Instagram app has no scheduled_posts row to point at, and restricting
     * this table to app-published posts is what left it permanently empty —
     * the brand's actual posting history was invisible to the feedback loop.
     * Set when the post did originate here, so post-level feedback can still
     * be attributed back to the campaign that produced it.
     */
    scheduledPostId: text('scheduled_post_id').references(() => scheduledPosts.id, {
      onDelete: 'set null',
    }),
    /** The Instagram media this row measures. The stable identity here —
     *  `scheduledPostId` is absent for anything posted outside the app. */
    igMediaId: text('ig_media_id').notNull(),
    /** Which connection this was read through; a brand may reconnect or swap
     *  accounts, and metrics should not silently merge across them. */
    socialAccountId: text('social_account_id').references(() => socialAccounts.id, {
      onDelete: 'cascade',
    }),
    /** Denormalized from scheduledPosts for per-brand queries without a join. */
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    likeCount: integer('like_count'),
    commentsCount: integer('comments_count'),
    reach: integer('reach'),
    saved: integer('saved'),
    /** Post caption and permalink, kept so analysis and the UI don't need a
     *  second Graph call to say *which* post a number belongs to. */
    caption: text('caption'),
    permalink: text('permalink'),
    mediaType: text('media_type'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    /** Set when the fetch itself failed; the typed columns above are null in
     *  that case. Mirrors probe_runs.error. */
    error: text('error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('post_insights_scheduled_post_fetched_idx').on(t.scheduledPostId, t.fetchedAt),
    index('post_insights_brand_fetched_idx').on(t.brandId, t.fetchedAt),
    /** Reads are "latest metrics for this media", so the sweep can upsert one
     *  row per media per run without scanning. */
    index('post_insights_media_fetched_idx').on(t.igMediaId, t.fetchedAt),
  ],
);

/**
 * Individual comments on a brand's Instagram posts — the raw community
 * response, stored verbatim so analysis can run over it later without
 * re-fetching (Instagram pages comments, and old ones fall out of easy reach).
 *
 * Readable with the `instagram_business_basic` scope the connection already
 * carries; no `manage_comments` grant is needed just to read them.
 */
export const postComments = content.table(
  'post_comments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Instagram's own comment id. Unique so a re-sync updates the existing
     *  row rather than accumulating a copy per sweep. */
    igCommentId: text('ig_comment_id').notNull(),
    igMediaId: text('ig_media_id').notNull(),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    socialAccountId: text('social_account_id').references(() => socialAccounts.id, {
      onDelete: 'cascade',
    }),
    text: text('text'),
    username: text('username'),
    likeCount: integer('like_count'),
    /** When the comment was posted, per Instagram — not when we read it. */
    commentedAt: timestamp('commented_at', { withTimezone: true }),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('post_comments_ig_comment_id_idx').on(t.igCommentId),
    index('post_comments_media_idx').on(t.igMediaId),
    index('post_comments_brand_commented_idx').on(t.brandId, t.commentedAt),
  ],
);

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

/** The fixed, India-scoped category taxonomy the research pool (Layer A, see
 *  research-pool.ts) is organized by. Mirrors `categoryKeySchema` in
 *  @bmas/shared — the two must stay in step, same rule `styleTemplate` above
 *  already follows. Free-text `brands.category`/`brand_contexts.industry`
 *  normalize into this lazily, cached on `brand_contexts.category_key` — see
 *  `ensureBrandCategoryKey` in content-worker. */
export const categoryKey = content.enum('category_key', [
  'technology',
  'fashion_apparel',
  'food_beverage',
  'fitness_wellness',
  'sports',
  'entertainment',
  'beauty_personal_care',
  'home_lifestyle',
  'finance',
  'travel_hospitality',
  'education',
  'other',
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

/** Bucketed from `score.overall` by `computeActionTier` (@bmas/shared) at
 *  write time — see the Trend Opportunity Engine header comment in
 *  trend-research.ts. Stored rather than recomputed on read so a later
 *  change to the score thresholds doesn't retroactively relabel old rows. */
export const trendActionTier = content.enum('trend_action_tier', [
  'immediate_action',
  'recommended',
  'monitor',
  'ignore',
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
    /** Which pool item (see the Global Research Pool section below) this
     *  opportunity's relevance was scored against, when Layer B sourced it
     *  from the pool rather than a fresh per-brand search. Null on rows from
     *  before the pool existed, and `ON DELETE SET NULL` so a pool item
     *  outliving its own cadence never blocks deleting a stale one. */
    poolItemId: text('pool_item_id').references((): AnyPgColumn => poolTrendItems.id, {
      onDelete: 'set null',
    }),
    /** The single product this opportunity was judged to best fit, or null if
     *  none in the brand's catalog genuinely tied in — see productRelevance
     *  in @bmas/shared. Required for auto-trigger, since a generation
     *  request always needs a product; `ON DELETE SET NULL` so deleting a
     *  product never blocks deleting an old opportunity. */
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** Computed once at write time by computeActionTier — see this column's
     *  enum doc comment above. */
    actionTier: trendActionTier('action_tier').notNull(),
    /** Whether the auto-trigger pipeline (opportunity-trigger.ts) already
     *  generated content for this opportunity. Guards against re-triggering
     *  the same opportunity if a run is ever retried. */
    autoTriggered: boolean('auto_triggered').notNull().default(false),
    autoTriggeredAt: timestamp('auto_triggered_at', { withTimezone: true }),
    /** The 3 generation jobs auto-trigger created, for the UI's "Recommended
     *  Content" section to link to and poll without a separate lookup. */
    generationJobIds: jsonb('generation_job_ids')
      .$type<AutoTriggeredJobRef[]>()
      .notNull()
      .default([]),
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
    /** Normalized from `industry` (falling back to the Brand Kit's free-text
     *  `category`) via a one-time LLM classification. Null until Layer B
     *  first needs it — classification is lazy, not eager, so brand creation
     *  and every context read stay LLM-free. See `ensureBrandCategoryKey`. */
    categoryKey: categoryKey('category_key'),
    /** The exact industry/category text `categoryKey` was classified from. An
     *  edit to `industry` changes this string, which is how a stale
     *  classification gets detected and re-run — cheaper than a dirty flag
     *  every unrelated field edit would also have to know to clear. */
    categoryKeyClassifiedFor: text('category_key_classified_for'),
    /** ISO 3166-1 alpha-2 country the brand trades in, normalized from the
     *  free-text `location` by the same lazy, cached classification the
     *  category above uses. Part of the research pool's bucket key: a US
     *  brand and an Indian brand must not share a pool of "upcoming
     *  festivals". Null until Layer B first needs it. */
    marketCode: text('market_code'),
    /** The exact location text `marketCode` was classified from — same
     *  staleness-detection trick as `categoryKeyClassifiedFor`. */
    marketCodeClassifiedFor: text('market_code_classified_for'),
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
    /** Non-null only when content-worker's inactivity sweep is the one that
     *  flipped `contentAutomationEnabled` off, never when the owner turned it
     *  off themselves — that distinction is the whole point of the column.
     *  Without it, the next login's "resume what we paused" pass would just
     *  as happily re-enable a brand the owner deliberately disabled. Cleared
     *  by AutomationSettingsService.updateSettings the moment anything turns
     *  automation back on, by any path. */
    autoPausedAt: timestamp('auto_paused_at', { withTimezone: true }),
    /** Separate from `approvalPolicy` so that moving to full autopilot does
     *  not silently grant the right to post to a live Instagram account —
     *  publishing is the one step with no undo. */
    autoPublishEnabled: boolean('auto_publish_enabled').notNull().default(false),
    approvalPolicy: approvalPolicy('approval_policy').notNull().default('assist'),
    /** Opt-in gate for the Trend Opportunity Engine's auto-trigger step (see
     *  maybeAutoTriggerBestOpportunity in trend-research.ts). Off by default
     *  — this spends real generation cost the moment a run produces an
     *  `immediate_action` opportunity, so it is deliberately a separate,
     *  narrower switch from `contentAutomationEnabled` rather than implied
     *  by it. */
    autoTriggerHighScoreOpportunities: boolean('auto_trigger_high_score_opportunities')
      .notNull()
      .default(false),
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

export const intelligenceUrgency = content.enum('intelligence_urgency', ['low', 'medium', 'high']);

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
    /** Same provenance link as `trend_opportunities.pool_item_id` — null for
     *  `competitor`/`brand_news` items, which are never pool-derived. */
    poolItemId: text('pool_item_id').references((): AnyPgColumn => poolIntelligenceItems.id, {
      onDelete: 'set null',
    }),
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
  run: one(intelligenceRuns, {
    fields: [intelligenceItems.runId],
    references: [intelligenceRuns.id],
  }),
}));

// ---------------------------------------------------------------------------
// Global Research Pool (Layer A)
//
// Trend Research and Intelligence Research used to run their whole
// search-and-synthesize pipeline once per brand, per click — cheap at one
// brand, but N brands in the same industry pay for and repeat nearly
// identical searches (a festival calendar, an industry news cycle) N times
// over. Most of what those searches surface is not actually brand-specific;
// only its *relevance* is.
//
// The pool is what makes that shareable: one search+synthesis pass runs per
// category (or once nationally, `scope = 'national'`, for things that are not
// industry-qualified at all — festival dates, general local news), on a fixed
// schedule independent of brand count. `trend_opportunities` /
// `intelligence_items` above are still what the app renders — a brand's own
// research run (Layer B) now loads the pool for its category and runs one
// cheap relevance-scoring call against it instead of searching the web
// itself, and records which pool item it scored via `pool_item_id`.
//
// See packages/shared/src/content/research-pool.ts for the Zod contracts and
// `apps/content-worker/src/pipeline/{trend,intelligence}-pool-refresh.ts` for
// the Layer A pipelines that populate these tables. Deliberately not a
// separate schema file the way core/geo get one each: every table here is
// still `content`-schema and content-workstream owned, and splitting it out
// would need a real circular import between two schema files (pool tables
// reference `trend_category`/`intelligence_category`/etc. defined above,
// while `trend_opportunities.pool_item_id` above references the pool tables
// back) — one file avoids that entirely.
// ---------------------------------------------------------------------------

export const poolRunStatus = content.enum('pool_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

export const poolRunScope = content.enum('pool_run_scope', ['category', 'national']);

/** One Layer A trend refresh — search + synthesis run once for a category (or
 *  once nationally for `event_festival`, which isn't industry-qualified in
 *  the query text — see buildTrendPoolQueries), shared by every brand in
 *  scope. The category-level counterpart of `trend_research_runs`. */
export const poolTrendRuns = content.table(
  'pool_trend_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    scope: poolRunScope('scope').notNull(),
    /** Null iff scope = 'national'. */
    category: categoryKey('category'),
    /** ISO 3166-1 alpha-2 market this bucket covers. Part of the bucket key:
     *  "upcoming festivals" means something different per country, so pools
     *  must not be shared across markets. Defaulted rather than nullable so
     *  every existing row keeps the market it was actually built for. */
    market: text('market').notNull().default('IN'),
    status: poolRunStatus('status').notNull().default('queued'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** When this run's items stop counting as fresh. Set once the run
     *  succeeds, from `poolExpiresAt` in @bmas/shared — stored rather than
     *  derived so "is the pool stale" is a plain `expiresAt < now()`
     *  comparison, same reasoning `automation_settings.nextResearchAt`
     *  already documents. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pool_trend_runs_scope_category_created_idx').on(
      t.scope,
      t.category,
      t.market,
      t.createdAt,
    ),
    index('pool_trend_runs_expires_idx').on(t.expiresAt),
    // At most one active (queued/running) refresh per bucket — closes the
    // exact race `asset_edits_one_active_per_root_idx` closes in
    // generations.service.ts: the scheduler tick and a brand's lazy backfill
    // can both decide the same bucket is stale at the same moment, and only
    // one may actually run the refresh. The loser's insert gets a Postgres
    // 23505 the caller (pool-loader.ts) catches and polls on instead.
    uniqueIndex('pool_trend_runs_one_active_per_bucket_idx')
      .on(t.scope, t.category, t.market)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export const poolTrendItems = content.table(
  'pool_trend_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => poolTrendRuns.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    category: trendCategory('category').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    /** A generic recommendation, not yet brand-specific — Layer B may
     *  override this per brand rather than always reusing it verbatim. */
    recommendation: text('recommendation').notNull(),
    contentType: trendContentType('content_type').notNull(),
    /** Brand-agnostic axes only (popularity/freshness/marketingPotential) —
     *  brandRelevance/audienceRelevance don't exist yet at this layer. See
     *  trendPoolScoreSchema in @bmas/shared. */
    score: jsonb('score').$type<TrendPoolScore>().notNull(),
    signalCount: integer('signal_count').notNull(),
    sources: jsonb('sources').$type<TrendSource[]>().notNull().default([]),
    suggestedRequest: jsonb('suggested_request').$type<TrendSuggestedRequest>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pool_trend_items_run_idx').on(t.runId),
    index('pool_trend_items_category_idx').on(t.category),
  ],
);

/** Raw evidence for the trend pool — same shape and purpose as
 *  `trend_signals` above, now backing many brands per row instead of one. */
export const poolTrendSignals = content.table(
  'pool_trend_signals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => poolTrendRuns.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    signalType: text('signal_type').notNull(),
    topic: text('topic'),
    title: text('title').notNull(),
    snippet: text('snippet').notNull(),
    strength: real('strength').notNull(),
    sourceUrl: text('source_url').notNull(),
    publishedAt: text('published_at'),
    poolItemId: text('pool_item_id').references((): AnyPgColumn => poolTrendItems.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pool_trend_signals_run_idx').on(t.runId),
    index('pool_trend_signals_item_idx').on(t.poolItemId),
  ],
);

export const poolIntelligenceRuns = content.table(
  'pool_intelligence_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    scope: poolRunScope('scope').notNull(),
    category: categoryKey('category'),
    /** ISO 3166-1 alpha-2 market this bucket covers. Part of the bucket key:
     *  "upcoming festivals" means something different per country, so pools
     *  must not be shared across markets. Defaulted rather than nullable so
     *  every existing row keeps the market it was actually built for. */
    market: text('market').notNull().default('IN'),
    status: poolRunStatus('status').notNull().default('queued'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pool_intelligence_runs_scope_category_created_idx').on(
      t.scope,
      t.category,
      t.market,
      t.createdAt,
    ),
    index('pool_intelligence_runs_expires_idx').on(t.expiresAt),
    uniqueIndex('pool_intelligence_runs_one_active_per_bucket_idx')
      .on(t.scope, t.category, t.market)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export const poolIntelligenceItems = content.table(
  'pool_intelligence_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text('run_id')
      .notNull()
      .references(() => poolIntelligenceRuns.id, { onDelete: 'cascade' }),
    /** Reuses the existing `intelligence_category` enum above, but only ever
     *  holds 'government_policy' | 'industry_news' | 'local' here —
     *  'competitor' and 'brand_news' are inherently brand-specific and never
     *  pooled. The narrower `poolableIntelligenceCategorySchema` in
     *  @bmas/shared is what actually constrains writes; the DB enum stays the
     *  full vocabulary `intelligence_items` also uses. */
    category: intelligenceCategory('category').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    urgency: intelligenceUrgency('urgency').notNull(),
    /** businessImpact + recency only — brandRelevance/industryRelevance/
     *  geographicRelevance are Layer B's job (geographicRelevance in
     *  particular needs the brand's own trading city, which a pool item
     *  deliberately does not have). */
    score: jsonb('score').$type<IntelligencePoolScore>().notNull(),
    sources: jsonb('sources').$type<TrendSource[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pool_intelligence_items_run_idx').on(t.runId),
    index('pool_intelligence_items_category_idx').on(t.category),
  ],
);
// No poolIntelligenceSignals table — matches intelligence-research.ts's own
// existing choice not to persist raw search results, unlike trend research.

export const poolTrendRunsRelations = relations(poolTrendRuns, ({ many }) => ({
  items: many(poolTrendItems),
  signals: many(poolTrendSignals),
}));

export const poolTrendItemsRelations = relations(poolTrendItems, ({ one, many }) => ({
  run: one(poolTrendRuns, { fields: [poolTrendItems.runId], references: [poolTrendRuns.id] }),
  signals: many(poolTrendSignals),
}));

export const poolTrendSignalsRelations = relations(poolTrendSignals, ({ one }) => ({
  run: one(poolTrendRuns, { fields: [poolTrendSignals.runId], references: [poolTrendRuns.id] }),
  item: one(poolTrendItems, {
    fields: [poolTrendSignals.poolItemId],
    references: [poolTrendItems.id],
  }),
}));

export const poolIntelligenceRunsRelations = relations(poolIntelligenceRuns, ({ many }) => ({
  items: many(poolIntelligenceItems),
}));

export const poolIntelligenceItemsRelations = relations(poolIntelligenceItems, ({ one }) => ({
  run: one(poolIntelligenceRuns, {
    fields: [poolIntelligenceItems.runId],
    references: [poolIntelligenceRuns.id],
  }),
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

// ---------------------------------------------------------------------------
// Marketing Plan
//
// The layer above `trend_opportunities`. An opportunity is a single reactive
// idea ("post about Diwali"); a plan is the standing answer to "what are we
// doing over the next few weeks, and why" — the thing a marketing team would
// keep on a whiteboard. It is synthesized from the Brand Brain, the newest
// trend opportunities, competitor intelligence, and GEO visibility, so it can
// justify itself with evidence rather than restating the brand kit.
//
// Exactly one plan per brand is `active` at a time. Revising never edits in
// place: the planner writes a new plan and marks the previous one
// `superseded`, so "why were we doing that last week" stays answerable and a
// user can see what their own steering actually changed.
// ---------------------------------------------------------------------------

export const planStatus = content.enum('plan_status', [
  'draft',
  'active',
  /** Replaced by a newer plan — kept for history, never shown as current. */
  'superseded',
]);

/**
 * Why this plan exists in the shape it does.
 *
 * `scheduled` plans come from the autonomous loop; `directive` plans were
 * produced because the user steered. Stored rather than inferred from the
 * presence of a directive id, because a directive can also *refine* a plan
 * that a schedule originally created.
 */
export const planOrigin = content.enum('plan_origin', ['scheduled', 'directive', 'manual']);

export const marketingPlans = content.table(
  'marketing_plans',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    status: planStatus('status').notNull().default('draft'),
    origin: planOrigin('origin').notNull().default('scheduled'),
    /** How far ahead this plan reaches. Drives the item spacing, and is what
     *  the user is really choosing when they ask for "a plan for this month". */
    horizonDays: integer('horizon_days').notNull().default(14),
    /** One line the user actually reads first: what this plan is trying to
     *  move — "own the marathon-season conversation in Delhi". */
    headline: text('headline').notNull(),
    /** The reasoning, in the planner's own words, citing what it saw. This is
     *  the difference between a plan and a list. */
    rationale: text('rationale').notNull(),
    /** The current theme in the user's language, e.g. "100m dash, Delhi".
     *  Set from a directive when the user redirects; null when the planner
     *  chose the focus itself. */
    focus: text('focus'),
    /** What the planner read, so a plan can be explained after the sources
     *  themselves have rotated out of the pool. */
    evidence: jsonb('evidence').$type<PlanEvidence>().notNull().default({
      opportunityIds: [],
      intelligenceItemIds: [],
      notes: [],
      geoScoreAtPlanning: null,
    }),
    /** The plan this one replaced, newest-first chain. */
    supersedesId: text('supersedes_id').references((): AnyPgColumn => marketingPlans.id, {
      onDelete: 'set null',
    }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('marketing_plans_brand_created_idx').on(t.brandId, t.createdAt),
    // The only hot query: this brand's current plan.
    index('marketing_plans_brand_status_idx').on(t.brandId, t.status),
    // At most ONE active plan per brand, enforced by the database rather than
    // by the planner's transaction alone.
    //
    // `installPlan` reads the current active plan and then inserts the new
    // one. Two planners running concurrently for the same brand — a scheduled
    // refresh landing while the user steers, say — can both read the same
    // "previous" and both insert, leaving two rows claiming to be current.
    // Every reader here uses `limit(1)`, so the second plan would not error;
    // it would silently disappear, taking its proposed items out of the inbox
    // with it. A partial unique index turns that race into a failed
    // transaction that rolls back and retries, which is the outcome we want.
    uniqueIndex('marketing_plans_one_active_per_brand_idx')
      .on(t.brandId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * Nothing is generated from a plan item until it is `approved`.
 *
 * That is the whole point of the status column: the planner may propose
 * freely, because proposing costs one model call for the whole plan, while
 * generating costs image spend per item. `proposed -> approved` is the only
 * transition a human makes, and it is the only one that spends money.
 */
export const planItemStatus = content.enum('plan_item_status', [
  'proposed',
  'approved',
  'rejected',
  /** Generation enqueued; `generationJobId` is set. */
  'generating',
  'ready',
  'scheduled',
  'published',
  'failed',
]);

export const planItems = content.table(
  'plan_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    planId: text('plan_id')
      .notNull()
      .references(() => marketingPlans.id, { onDelete: 'cascade' }),
    /** Denormalized from the plan so the inbox can scope by brand without a
     *  join on every read. */
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Position in the plan, 0-based. Ordering is editorial, not chronological
     *  — an item can be undated. */
    sequence: integer('sequence').notNull(),
    title: text('title').notNull(),
    /** Why this specific post, in one or two sentences the user can argue with. */
    rationale: text('rationale').notNull(),
    contentType: trendContentType('content_type').notNull(),
    /** Prefills the generation request on approval. Same shape the trend
     *  engine already uses, so approval reuses that path untouched. */
    suggestedRequest: jsonb('suggested_request').$type<TrendSuggestedRequest>().notNull(),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** The opportunity this item was built on, when it came from one. */
    opportunityId: text('opportunity_id').references(() => trendOpportunities.id, {
      onDelete: 'set null',
    }),
    /** When the plan intends this to go out. Null means "sometime in the
     *  horizon" — the planner does not always have a reason to pick a day. */
    plannedFor: timestamp('planned_for', { withTimezone: true }),
    status: planItemStatus('status').notNull().default('proposed'),
    generationJobId: text('generation_job_id').references(() => generationJobs.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('plan_items_plan_seq_idx').on(t.planId, t.sequence),
    // Backs the approval inbox: this brand's items awaiting a human.
    index('plan_items_brand_status_idx').on(t.brandId, t.status),
  ],
);

/**
 * The steering conversation (the chat).
 *
 * A user redirects the whole plan by saying so in plain language — "focus on
 * the 100m dash in Delhi instead" — and that single message is the entire
 * interface. Each message is a row; the agent's replies are rows too, so the
 * panel is just this table in order.
 *
 * `status` tracks the work one user message set off, because a redirect is not
 * instant: it researches the new topic first, then re-plans. The user watches
 * that happen rather than waiting on a spinner with no explanation.
 */
export const directiveRole = content.enum('directive_role', ['user', 'agent']);

export const directiveIntent = content.enum('directive_intent', [
  /** Change what the plan is about. Triggers research, then a new plan. */
  'redirect',
  /** Keep the subject, change the treatment — tone, channel, cadence. */
  'refine',
  /** "Yes, do it" — approves the current plan's proposed items. */
  'approve',
  /** A question about the plan; answered without changing it. */
  'question',
  'unclear',
]);

export const directiveStatus = content.enum('directive_status', [
  'pending',
  'researching',
  'planning',
  'applied',
  'failed',
]);

export const planDirectives = content.table(
  'plan_directives',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** The plan this message was said *about*. Null for a message sent before
     *  any plan exists, which is a legitimate way to start one. */
    planId: text('plan_id').references((): AnyPgColumn => marketingPlans.id, {
      onDelete: 'set null',
    }),
    role: directiveRole('role').notNull(),
    text: text('text').notNull(),
    /** Only set on user rows, and only once classified. */
    intent: directiveIntent('intent'),
    status: directiveStatus('status').notNull().default('pending'),
    /** The plan this directive produced, once it has produced one. */
    resultingPlanId: text('resulting_plan_id').references((): AnyPgColumn => marketingPlans.id, {
      onDelete: 'set null',
    }),
    /** The directed research run this directive kicked off, so the panel can
     *  show "researching the 100m dash in Delhi" against real progress. */
    researchRunId: text('research_run_id').references((): AnyPgColumn => trendResearchRuns.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('plan_directives_brand_created_idx').on(t.brandId, t.createdAt)],
);

export const marketingPlansRelations = relations(marketingPlans, ({ one, many }) => ({
  brand: one(brands, { fields: [marketingPlans.brandId], references: [brands.id] }),
  items: many(planItems),
}));

export const planItemsRelations = relations(planItems, ({ one }) => ({
  plan: one(marketingPlans, { fields: [planItems.planId], references: [marketingPlans.id] }),
  opportunity: one(trendOpportunities, {
    fields: [planItems.opportunityId],
    references: [trendOpportunities.id],
  }),
}));

export type MarketingPlanRow = typeof marketingPlans.$inferSelect;
export type NewMarketingPlanRow = typeof marketingPlans.$inferInsert;
export type PlanItemRow = typeof planItems.$inferSelect;
export type NewPlanItemRow = typeof planItems.$inferInsert;
export type PlanDirectiveRow = typeof planDirectives.$inferSelect;
export type NewPlanDirectiveRow = typeof planDirectives.$inferInsert;

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

export type PoolTrendRunRow = typeof poolTrendRuns.$inferSelect;
export type NewPoolTrendRunRow = typeof poolTrendRuns.$inferInsert;
export type PoolTrendItemRow = typeof poolTrendItems.$inferSelect;
export type NewPoolTrendItemRow = typeof poolTrendItems.$inferInsert;
export type PoolTrendSignalRow = typeof poolTrendSignals.$inferSelect;
export type NewPoolTrendSignalRow = typeof poolTrendSignals.$inferInsert;
export type PoolIntelligenceRunRow = typeof poolIntelligenceRuns.$inferSelect;
export type NewPoolIntelligenceRunRow = typeof poolIntelligenceRuns.$inferInsert;
export type PoolIntelligenceItemRow = typeof poolIntelligenceItems.$inferSelect;
export type NewPoolIntelligenceItemRow = typeof poolIntelligenceItems.$inferInsert;

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
export type PostInsightRow = typeof postInsights.$inferSelect;
export type NewPostInsightRow = typeof postInsights.$inferInsert;
export type PostCommentRow = typeof postComments.$inferSelect;
export type NewPostCommentRow = typeof postComments.$inferInsert;
export type PushToken = typeof pushTokens.$inferSelect;
export type NewPushToken = typeof pushTokens.$inferInsert;
