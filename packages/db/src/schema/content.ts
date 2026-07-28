import { relations } from 'drizzle-orm';
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
} from 'drizzle-orm/pg-core';
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
    /** Ordered natural-language edits applied to this asset (FR-3.3). */
    edits: jsonb('edits').$type<Array<{ instruction: string; at: string }>>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('creative_assets_job_idx').on(t.jobId)],
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

export const creativeAssetsRelations = relations(creativeAssets, ({ one }) => ({
  job: one(generationJobs, { fields: [creativeAssets.jobId], references: [generationJobs.id] }),
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
  'completed',
  'cancelled',
]);

export const scheduledPostStatus = content.enum('scheduled_post_status', [
  'pending_generation',
  'pending_approval',
  'approved',
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
