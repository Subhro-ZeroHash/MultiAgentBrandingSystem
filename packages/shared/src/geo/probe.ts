import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { answerEngineSchema } from './engine.js';

/** One execution of one tracked prompt against one engine. */
export const probeRunSchema = z.object({
  id: entityIdSchema,
  promptId: entityIdSchema,
  engine: answerEngineSchema,
  model: z.string(),
  /** Raw answer text, kept for re-scoring when the analyser changes. */
  answerText: z.string(),
  citations: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable(),
      /** 1-based order the engine listed the source in. */
      rank: z.number().int().positive(),
    }),
  ),
  latencyMs: z.number().int().nonnegative(),
  runAt: z.coerce.date(),
});
export type ProbeRun = z.infer<typeof probeRunSchema>;

export const sentimentSchema = z.enum(['positive', 'neutral', 'negative']);
export type Sentiment = z.infer<typeof sentimentSchema>;

/**
 * An extracted brand (or competitor) mention inside one answer. Produced by the
 * analysis stage, which reads `answerText` and attributes claims to entities.
 */
export const mentionSchema = z.object({
  id: entityIdSchema,
  probeRunId: entityIdSchema,
  /** Either the tracked brand or one of its competitors. */
  entityType: z.enum(['brand', 'competitor']),
  entityId: entityIdSchema,
  entityName: z.string(),
  /** 1-based position among all entities named in the answer. */
  position: z.number().int().positive(),
  sentiment: sentimentSchema,
  /** Verbatim span the mention was extracted from — the audit trail. */
  excerpt: z.string().max(1000),
  /** Whether the engine backed the mention with a source URL. */
  citedUrl: z.string().nullable(),
});
export type Mention = z.infer<typeof mentionSchema>;

/** What the analysis stage returns for a single probe run. */
export const probeAnalysisSchema = z.object({
  brandMentioned: z.boolean(),
  mentions: z.array(mentionSchema.omit({ id: true, probeRunId: true })),
  /** One-line summary of how the engine characterised the brand. */
  summary: z.string().max(500),
});
export type ProbeAnalysis = z.infer<typeof probeAnalysisSchema>;
