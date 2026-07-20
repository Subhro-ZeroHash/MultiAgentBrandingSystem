import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { brands } from './core.js';

/** Owned by the GEO workstream. */
export const geo = pgSchema('geo');

export const answerEngine = geo.enum('answer_engine', [
  'chatgpt',
  'perplexity',
  'gemini',
  'claude',
  'copilot',
  'ai_overviews',
]);

export const promptIntent = geo.enum('prompt_intent', [
  'discovery',
  'comparison',
  'brand_direct',
  'transactional',
  'informational',
]);

export const sentiment = geo.enum('sentiment', ['positive', 'neutral', 'negative']);

export const entityType = geo.enum('entity_type', ['brand', 'competitor']);

export const trackedPrompts = geo.table(
  'tracked_prompts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    intent: promptIntent('intent').notNull(),
    /** Country code, or a city for local-intent prompts. */
    locale: text('locale'),
    engines: jsonb('engines').$type<string[]>().notNull().default([]),
    /** Cron expression driving the probe cadence. */
    schedule: text('schedule').notNull().default('0 6 * * 1'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tracked_prompts_brand_idx').on(t.brandId),
    index('tracked_prompts_active_idx').on(t.isActive),
  ],
);

export const competitors = geo.table(
  'competitors',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: text('domain'),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('competitors_brand_idx').on(t.brandId)],
);

/**
 * One prompt executed against one engine at one point in time. `answerText` is
 * retained so mentions can be re-derived when the analyser changes without
 * re-paying for the probe.
 */
export const probeRuns = geo.table(
  'probe_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    promptId: text('prompt_id')
      .notNull()
      .references(() => trackedPrompts.id, { onDelete: 'cascade' }),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    engine: answerEngine('engine').notNull(),
    model: text('model').notNull(),
    answerText: text('answer_text').notNull(),
    citations: jsonb('citations')
      .$type<Array<{ url: string; title: string | null; rank: number }>>()
      .notNull()
      .default([]),
    /** Set when the probe itself failed; answerText is empty in that case. */
    error: text('error'),
    latencyMs: integer('latency_ms'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('probe_runs_prompt_run_idx').on(t.promptId, t.runAt),
    index('probe_runs_brand_run_idx').on(t.brandId, t.runAt),
    index('probe_runs_engine_idx').on(t.engine),
  ],
);

export const mentions = geo.table(
  'mentions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    probeRunId: text('probe_run_id')
      .notNull()
      .references(() => probeRuns.id, { onDelete: 'cascade' }),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    entityType: entityType('entity_type').notNull(),
    /** brands.id or competitors.id depending on entityType. */
    entityId: text('entity_id').notNull(),
    entityName: text('entity_name').notNull(),
    /** 1-based order among entities named in the answer. */
    position: integer('position').notNull(),
    sentiment: sentiment('sentiment').notNull().default('neutral'),
    excerpt: text('excerpt').notNull(),
    citedUrl: text('cited_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('mentions_run_idx').on(t.probeRunId),
    index('mentions_brand_entity_idx').on(t.brandId, t.entityType, t.entityId),
  ],
);

/**
 * Pre-aggregated scores. The dashboard and weekly digest read only from here —
 * nothing recomputes from `probe_runs` at read time.
 */
export const visibilitySnapshots = geo.table(
  'visibility_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    /** Null means "rolled up across all engines". */
    engine: answerEngine('engine'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),

    presenceRate: real('presence_rate').notNull(),
    averagePosition: real('average_position'),
    shareOfVoice: real('share_of_voice').notNull(),
    citationRate: real('citation_rate').notNull(),
    sentimentScore: real('sentiment_score').notNull(),
    /** 0-100 headline number; see computeGeoScore in @bmas/shared. */
    geoScore: integer('geo_score').notNull(),

    promptsProbed: integer('prompts_probed').notNull().default(0),
    runsProbed: integer('runs_probed').notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('visibility_snapshots_brand_period_idx').on(t.brandId, t.periodStart)],
);

export const trackedPromptsRelations = relations(trackedPrompts, ({ one, many }) => ({
  brand: one(brands, { fields: [trackedPrompts.brandId], references: [brands.id] }),
  runs: many(probeRuns),
}));

export const probeRunsRelations = relations(probeRuns, ({ one, many }) => ({
  prompt: one(trackedPrompts, {
    fields: [probeRuns.promptId],
    references: [trackedPrompts.id],
  }),
  mentions: many(mentions),
}));

export const mentionsRelations = relations(mentions, ({ one }) => ({
  probeRun: one(probeRuns, { fields: [mentions.probeRunId], references: [probeRuns.id] }),
}));

export type TrackedPromptRow = typeof trackedPrompts.$inferSelect;
export type NewTrackedPrompt = typeof trackedPrompts.$inferInsert;
export type ProbeRunRow = typeof probeRuns.$inferSelect;
export type NewProbeRun = typeof probeRuns.$inferInsert;
export type MentionRow = typeof mentions.$inferSelect;
export type VisibilitySnapshotRow = typeof visibilitySnapshots.$inferSelect;
