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

export type SocialAccount = typeof socialAccounts.$inferSelect;
export type NewSocialAccount = typeof socialAccounts.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type NewGenerationJob = typeof generationJobs.$inferInsert;
export type CreativeAsset = typeof creativeAssets.$inferSelect;
export type CopyPackRow = typeof copyPacks.$inferSelect;
