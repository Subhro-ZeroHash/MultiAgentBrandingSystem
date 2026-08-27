import { relations } from 'drizzle-orm';
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
} from 'drizzle-orm/pg-core';
// Type-only: the schema files stay free of runtime imports, but the jsonb
// payloads are worth typing against the shared contract that validates them.
import type { SiteAnalysis, SiteExtraction } from '@bmas/shared';

/**
 * `core` holds what both systems share: accounts and the Brand Kit. Changes
 * here affect content generation and GEO alike — both owners review.
 */
export const core = pgSchema('core');

export const users = core.table(
  'users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text('email').notNull(),
    name: text('name'),
    /** bcrypt hash. Null for accounts created before auth existed (the seed's
     *  `dev-user`) or via a future OAuth-only signup — never compared against
     *  directly, only through AuthService.login's bcrypt.compare. */
    passwordHash: text('password_hash'),
    emailVerified: boolean('email_verified').notNull().default(false),
    imageUrl: text('image_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const brands = core.table(
  'brands',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    /** Up to 3 hex colors, ordered primary -> accent. */
    colors: jsonb('colors').$type<string[]>().notNull().default([]),
    /** Values constrained by `toneOfVoiceSchema` in @bmas/shared, not a DB enum
     *  — a brand can hold more than one, e.g. ['elegant', 'premium']. */
    tone: jsonb('tone').$type<string[]>().notNull().default(['friendly']),
    category: text('category'),
    audience: text('audience'),
    /** City/region the business trades from, e.g. "Jaipur". Free text: brands
     *  span too many locales for a fixed list to be worth maintaining. */
    location: text('location'),
    /** Languages the brand writes in, e.g. ['Hindi', 'English']. First is the
     *  default when a generation request does not specify one. */
    languages: jsonb('languages').$type<string[]>().notNull().default([]),
    /** Social platforms this brand is active on. Informational context for
     *  generation; a request's own `outputFormat` still decides the copy pack's
     *  platform for that run. */
    platforms: jsonb('platforms').$type<string[]>().notNull().default([]),
    /** Subjects generation must never reference for this brand — enforced as a
     *  hard constraint in the brief and copy prompts, not a suggestion. */
    bannedTopics: jsonb('banned_topics').$type<string[]>().notNull().default([]),
    websiteUrl: text('website_url'),
    socialHandles: jsonb('social_handles').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('brands_owner_idx').on(t.ownerId)],
);

/**
 * Append-only spend log. Written by every provider call in both systems so
 * per-brand unit economics are answerable without instrumenting later.
 */
export const costEvents = core.table(
  'cost_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    /** 'content' | 'geo' — which system incurred the cost. */
    system: text('system').notNull(),
    /** Free-form correlation id: a generation job id or a probe run id. */
    referenceId: text('reference_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    operation: text('operation').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    imageCount: integer('image_count'),
    /** Set instead of `imageCount` by a video provider — mirrors
     *  `CostEvent.videoSeconds` in @bmas/shared. */
    videoSeconds: real('video_seconds'),
    /** Micro-USD (1e-6) so the ledger stays in integers. */
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull(),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cost_events_brand_created_idx').on(t.brandId, t.createdAt),
    index('cost_events_system_idx').on(t.system),
  ],
);

export const siteProfileStatus = core.enum('site_profile_status', [
  'ok',
  /** Fetched, but the body was effectively empty — almost always a
   *  client-rendered SPA that ships a shell and paints in JavaScript. */
  'empty_document',
  'unreachable',
  'failed',
]);

/**
 * What the brand's own website says about how it presents itself (FR-1.4).
 *
 * A separate table rather than columns on `brands` for three reasons: it is a
 * cache of someone else's resource and carries its own freshness, it holds a
 * page's worth of text that nothing reading the Brand Kit wants to load, and
 * `brands` is shared with GEO where none of this applies.
 *
 * One row per brand — a re-import replaces the previous reading rather than
 * accumulating history, since only the current state of the site is useful.
 */
export const brandSiteProfiles = core.table(
  'brand_site_profiles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    sourceUrl: text('source_url').notNull(),
    status: siteProfileStatus('status').notNull(),
    /** The deterministic pass: colours, fonts, headings, visible copy. Kept
     *  verbatim so the analysis can be re-run against a better prompt without
     *  fetching someone else's server a second time. */
    extraction: jsonb('extraction').$type<SiteExtraction>(),
    /** The model's reading of the extraction. Null while a fetch failed. */
    analysis: jsonb('analysis').$type<SiteAnalysis>(),
    /** The brand's logo, copied into our bucket at import time. The image
     *  stage needs bytes, and a hotlink to someone's CDN breaks on redesign. */
    logoStorageKey: text('logo_storage_key'),
    /** Brand photography kept as visual style reference for the image model. */
    styleReferenceKeys: jsonb('style_reference_keys').$type<string[]>().notNull().default([]),
    /** Set when the user opts the logo into generation. Separate from
     *  `appliedAt` because a misidentified logo puts someone else's trademark
     *  on the brand's advertising — a different class of mistake from a
     *  merely wrong art direction. */
    logoAppliedAt: timestamp('logo_applied_at', { withTimezone: true }),
    /** Set when the user opts the brand's photography into conditioning. */
    styleReferencesAppliedAt: timestamp('style_references_applied_at', { withTimezone: true }),
    error: text('error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null until the user accepts the proposal. The generation pipeline reads
     *  only applied rows, so an import the user rejected stays inert instead of
     *  quietly restyling every creative. */
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('brand_site_profiles_brand_idx').on(t.brandId)],
);

export const usersRelations = relations(users, ({ many }) => ({
  brands: many(brands),
}));

export const brandsRelations = relations(brands, ({ one }) => ({
  owner: one(users, { fields: [brands.ownerId], references: [users.id] }),
  siteProfile: one(brandSiteProfiles, {
    fields: [brands.id],
    references: [brandSiteProfiles.brandId],
  }),
}));

export const brandSiteProfilesRelations = relations(brandSiteProfiles, ({ one }) => ({
  brand: one(brands, { fields: [brandSiteProfiles.brandId], references: [brands.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;
export type BrandSiteProfileRow = typeof brandSiteProfiles.$inferSelect;
export type NewBrandSiteProfileRow = typeof brandSiteProfiles.$inferInsert;
