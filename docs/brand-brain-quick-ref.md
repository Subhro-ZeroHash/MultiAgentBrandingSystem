# Brand Brain Quick Reference

For developers integrating Brand Brain into new features or debugging existing ones. Recreated after `docs/` was lost from disk; see the note at the top of [brand-brain-system.md](brand-brain-system.md).

## Imports

```typescript
import {
  getTrendContext,
  getContentContext,
  getPublishingContext,
  getCampaignContext,
  recordContextSnapshot,
  recordFeedbackSignal,
  type ContentTaskContext,
  type TrendTaskContext,
  FEEDBACK_CONFIDENCE,
  CONTEXT_LIMITS,
} from '@bmas/db';
```

All exports from `packages/db/src/context/context-manager.ts`.

## Common patterns

### Recording feedback from a trend opportunity or a lead

```typescript
// Ignored a trend opportunity / dismissed a lead
await recordFeedbackSignal(db, {
  brandId,
  kind: 'rejected',
  type: 'topic', // overrides FEEDBACK_TYPE['rejected'] if it would differ
  summary: `Ignored as not relevant: "${opportunity.title}"`,
  detail: { category: opportunity.category, trendOpportunityId: opportunity.id },
});

// Chose to act on / saved a trend opportunity or lead
await recordFeedbackSignal(db, {
  brandId,
  kind: 'variant_selected',
  type: 'topic',
  summary: `Chose to act on: "${opportunity.title}"`,
  detail: { category: opportunity.category, trendOpportunityId: opportunity.id },
});
```

### Querying context for specific purposes

```typescript
// Trend research and leads/intelligence (avoid repeat suggestions)
const trendCtx = await getTrendContext(db, brandId);
const recentTopics = trendCtx.recentTopics; // last 30 days of opportunity titles

// Content generation (full context)
const contentCtx = await getContentContext(db, brandId);
const learnings = contentCtx.learnings; // filtered by confidence floor
const rejected = contentCtx.rejectedPatterns;
```

## Constants

| Constant                               | Value | Purpose                               |
| -------------------------------------- | ----- | ------------------------------------- |
| `FEEDBACK_CONFIDENCE.approved`         | 0.25  | Stays below the prompt floor          |
| `FEEDBACK_CONFIDENCE.rejected`         | 0.5   | Reaches prompts immediately           |
| `FEEDBACK_CONFIDENCE.variant_selected` | 0.4   | Reaches prompts                       |
| `CONTEXT_LIMITS.MIN_PROMPT_CONFIDENCE` | 0.4   | Threshold for surfacing in briefs     |
| `CONTEXT_LIMITS.MAX_LEARNED`           | 5     | Max rows returned per preference type |

Pinned by tests in `packages/db/src/context/context-manager.test.ts` — changing either constant without checking the test is how approvals silently start reaching prompts.

## Tables

| Table                 | Written by                                          |
| --------------------- | --------------------------------------------------- |
| `brand_context`       | User edits, website re-import                       |
| `brand_preferences`   | `recordFeedbackSignal()` only — append-only         |
| `automation_settings` | Settings screen, the research scheduler tick        |
| `context_snapshots`   | Every pipeline that calls `recordContextSnapshot()` |
| `trend_signals`       | The trend-research worker pipeline, raw evidence    |
| `trend_opportunities` | The trend-research worker pipeline, post-synthesis  |

## Debugging checklist

**Learnings don't appear in briefs** — check `FEEDBACK_CONFIDENCE[kind]` ≥ `MIN_PROMPT_CONFIDENCE` (0.4); verify rows exist per type in `brand_preferences`.

**Approval is polluting prompts** — check `FEEDBACK_CONFIDENCE.approved` is still `< MIN_PROMPT_CONFIDENCE`; if either changed, that's the bug.

**Signals missing after a failed trend-research run** — should never happen post-fix: signals are persisted in their own transaction _before_ synthesis runs, specifically so a synthesis failure (bad LLM quota, timeout, rejected schema) doesn't discard the evidence. If signals are missing, check the transaction ordering in `apps/content-worker/src/pipeline/trend-research.ts` hasn't regressed — see [phase1-signal-intelligence-report.md](phase1-signal-intelligence-report.md) §3.4 for the original bug.
