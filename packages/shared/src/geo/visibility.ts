import { z } from 'zod';
import { entityIdSchema } from '../common.js';
import { answerEngineSchema } from './engine.js';

/**
 * Aggregate scores rolled up per brand / engine / period. These are what the
 * dashboard and the weekly digest read; nothing recomputes from raw runs at
 * read time.
 */

export const visibilitySnapshotSchema = z.object({
  id: entityIdSchema,
  brandId: entityIdSchema,
  engine: answerEngineSchema.nullable(), // null = across all engines
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),

  /** Share of tracked prompts where the brand appeared at all. 0-1. */
  presenceRate: z.number().min(0).max(1),
  /** Mean 1-based position when present. Lower is better. */
  averagePosition: z.number().positive().nullable(),
  /** Brand mentions / all entity mentions across the prompt set. 0-1. */
  shareOfVoice: z.number().min(0).max(1),
  /** Share of brand mentions that carried a source URL. 0-1. */
  citationRate: z.number().min(0).max(1),
  sentimentScore: z.number().min(-1).max(1),

  promptsProbed: z.number().int().nonnegative(),
  runsProbed: z.number().int().nonnegative(),
  computedAt: z.coerce.date(),
});
export type VisibilitySnapshot = z.infer<typeof visibilitySnapshotSchema>;

/**
 * Single headline number for the dashboard. Weighted so that "shows up at all"
 * dominates — an SMB that never appears cares about presence before position.
 */
export const GEO_SCORE_WEIGHTS = {
  presenceRate: 0.45,
  positionQuality: 0.2,
  shareOfVoice: 0.2,
  citationRate: 0.15,
} as const;

/** Positions beyond this contribute no position quality. */
const POSITION_HORIZON = 10;

export function computeGeoScore(
  snapshot: Pick<
    VisibilitySnapshot,
    'presenceRate' | 'averagePosition' | 'shareOfVoice' | 'citationRate'
  >,
): number {
  const positionQuality =
    snapshot.averagePosition === null
      ? 0
      : Math.max(0, (POSITION_HORIZON - (snapshot.averagePosition - 1)) / POSITION_HORIZON);

  const score =
    snapshot.presenceRate * GEO_SCORE_WEIGHTS.presenceRate +
    positionQuality * GEO_SCORE_WEIGHTS.positionQuality +
    snapshot.shareOfVoice * GEO_SCORE_WEIGHTS.shareOfVoice +
    snapshot.citationRate * GEO_SCORE_WEIGHTS.citationRate;

  return Math.round(score * 100);
}
