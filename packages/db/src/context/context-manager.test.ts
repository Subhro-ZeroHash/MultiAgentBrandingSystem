import { describe, expect, it } from 'vitest';
import { CONTEXT_LIMITS, FEEDBACK_CONFIDENCE } from './context-manager.js';

/**
 * Invariants between two constants that live apart and must not drift.
 *
 * Neither of these is enforced by a type or a query — they are numeric
 * relationships whose violation produces no error, just quietly worse prompts.
 * That is exactly the kind of thing a test is for.
 */
describe('feedback confidence against the prompt floor', () => {
  it('keeps a single approval below the floor that admits a learning into prompts', () => {
    // An approval says "good enough to ship" and nothing about why. Promoted
    // into a brief it would become the newest content_format learning and
    // displace a real measured finding with a sentence carrying no direction.
    // The aggregate is what Phase 5's analyzer should read, not one row.
    expect(FEEDBACK_CONFIDENCE.approved).toBeLessThan(CONTEXT_LIMITS.MIN_PROMPT_CONFIDENCE);
  });

  it('lets rejections and regenerations through, since those state what was wrong', () => {
    // The asymmetry is the point: a user who asks for a change has told us
    // something specific and costly to give. Those must reach the next brief.
    expect(FEEDBACK_CONFIDENCE.rejected).toBeGreaterThanOrEqual(
      CONTEXT_LIMITS.MIN_PROMPT_CONFIDENCE,
    );
    expect(FEEDBACK_CONFIDENCE.regenerated).toBeGreaterThanOrEqual(
      CONTEXT_LIMITS.MIN_PROMPT_CONFIDENCE,
    );
  });

  it('treats every kind as an anecdote, never a settled finding', () => {
    for (const [kind, confidence] of Object.entries(FEEDBACK_CONFIDENCE)) {
      expect(confidence, `${kind} should stay well under 1`).toBeLessThanOrEqual(0.5);
      expect(confidence, `${kind} should be positive`).toBeGreaterThan(0);
    }
  });

  it('can surface at least one learning per dimension', () => {
    // `loadLearnings` returns the newest row per preference type, capped at
    // MAX_LEARNED. There are five types; a cap below that would silently drop
    // whole dimensions — which is the same class of bug as the retrieval
    // starvation this cap replaced, arriving by a different route.
    expect(CONTEXT_LIMITS.MAX_LEARNED).toBeGreaterThanOrEqual(5);
  });
});
