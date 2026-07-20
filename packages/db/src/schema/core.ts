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

/**
 * `core` holds what both systems share: accounts and the Brand Kit. Changes
 * here affect content generation and GEO alike — both owners review.
 */
export const core = pgSchema('core');

export const toneOfVoice = core.enum('tone_of_voice', [
  'friendly',
  'premium',
  'playful',
  'traditional',
]);

export const users = core.table(
  'users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text('email').notNull(),
    name: text('name'),
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
    toneOfVoice: toneOfVoice('tone_of_voice').notNull().default('friendly'),
    category: text('category'),
    audience: text('audience'),
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

export const usersRelations = relations(users, ({ many }) => ({
  brands: many(brands),
}));

export const brandsRelations = relations(brands, ({ one }) => ({
  owner: one(users, { fields: [brands.ownerId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;
