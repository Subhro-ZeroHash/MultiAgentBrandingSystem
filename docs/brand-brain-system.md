# Brand Brain: Context & Memory System

**Status**: Phase 1 Complete | **Author**: Internship Team

Recreated after the `docs/` directory was lost from disk (uncommitted deletion,
cause unknown); this is a reconstruction from session history, not
byte-identical to the original but covering the same ground. For the
signal-based trend intelligence rebuild that came after this, see
[phase1-signal-intelligence-report.md](phase1-signal-intelligence-report.md).

## Executive Summary

The Brand Brain is a persistent context and memory system that transforms the Creative Content Agent from a stateless generator into a learning system. Instead of treating each generation as an isolated event, every brand now maintains an accumulated knowledge base — its identity, goals, positioning, learned preferences, and rejected patterns — that informs all future creative work.

| Aspect             | Before                                              | After                                                                                                                |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Context**        | Only website identity + latest trend                | Full brand kit: goals, positioning, pillars, competitors, products, audience, learned preferences, rejected patterns |
| **Memory**         | None; every generation started fresh                | Append-only preference log: rejections, regenerations, edits, approvals captured with confidence scoring             |
| **Prompts**        | Generic, brand-agnostic                             | Personalized: every brief includes brand positioning, content pillars, learned patterns, and learned rejections      |
| **Feedback loop**  | Closed; user corrections never informed future work | Open; approvals, rejections, and regenerations recorded and surfaced in the next generation's prompt                 |
| **Data structure** | Transient                                           | 4 tables: `brand_context`, `brand_preferences`, `automation_settings`, `context_snapshots`                           |

## Three-layer memory model

**1. Static (Brand Kit)** — read once at brand setup, updated by occasional user edits. Industry, location, audience, goals, competitors, products, colors, voice, website analysis. Stored in `brand_context`.

**2. Dynamic (recent activity)** — time-bounded, cleared by recency. Recent trends (30 days), recent publishing (7 days). Prevents prompt pollution and keeps briefs focused on now.

**3. Learned (preferences)** — append-only feedback log with confidence scoring:

- Rejected patterns (0.5) — what to stop doing
- Regeneration summaries (0.5) — what to change
- Edit notes (0.45) — specific corrections
- Variant selections (0.4) — preferred directions, and (as of the trend/leads rebuild) chosen trend opportunities / saved leads
- Approvals (0.25) — what shipped as-generated, filtered below the 0.4 prompt floor by design

## Context Manager

`packages/db/src/context/context-manager.ts` — the single source of truth for brand knowledge:

- **`getTrendContext(db, brandId)`** — trend research and leads/intelligence; goals, competitors, positioning, recent trends, learnings
- **`getContentContext(db, brandId, {includeTrend})`** — content generation; full brand kit + learnings + rejected patterns
- **`getPublishingContext(db, brandId)`** — publishing; automation settings, posting preferences
- **`getCampaignContext(db, brandId, campaignId)`** — scheduling; campaign-scoped status
- **`recordContextSnapshot(db, input)`** — logs what an agent was handed, for audit
- **`recordFeedbackSignal(db, input)`** — turns a user action into a `brand_preferences` row; accepts an optional `type` override so a kind's confidence weight can be filed under a different dimension (e.g. an ignored trend opportunity uses `kind: 'rejected'` confidence but `type: 'topic'`)

## Data model

**`brand_context`** — industry, location, audience, goals (jsonb array), competitors (jsonb), positioning, content_pillars (jsonb), source, confirmed_at.

**`brand_preferences`** — brand_id, preference_type (content_format/posting_time/visual_style/tone/topic), preference (jsonb: summary + value), confidence (real), learned_from (nullable FK to scheduled_posts, `ON DELETE SET NULL`). Indexed on `(brand_id, preference_type, created_at)` for the "newest per type" read, and on `learned_from` to prevent sequential scans on cascade deletes.

**`automation_settings`** — trend_frequency (daily/three_days/weekly), last/next_research_at, content_automation_enabled, auto_publish_enabled, approval_policy. Indexed on `(content_automation_enabled, next_research_at)` for the scheduler's due-brand query.

**`context_snapshots`** — agent_type, snapshot (jsonb), used_in_job_id. Site identity is stored as a one-line summary + reference rather than duplicated in full on every snapshot (53% smaller payload).

## Bugs found and fixed during the original Phase 1 debugging pass

1. **Learning starvation (critical)** — `loadLearnings` took the 50 newest preference rows across all types then deduped by type; regenerations (the most frequent action) dominated the window, and other preference types silently stopped reaching prompts after ~50 regenerations. Fixed: one indexed query per type instead of "take 50, dedupe."
2. **Missing index on `learned_from`** — cascade deletes from `scheduled_posts` sequentially scanned `brand_preferences`. Fixed with a dedicated index.
3. **Snapshot payload bloat** — full site identity was re-stored on every generation snapshot despite changing ~yearly. Fixed by storing a one-line summary + reference.
4. **Approval-confidence coupling** — approvals stay below the prompt floor only because two independently-defined constants happen to satisfy that inequality; pinned by a test so a future change to either constant can't silently let approvals pollute prompts.

## What this enables (Phase 2+)

- Quality correlation: do generations using learned preferences pass QA more often?
- Automated style discovery: extract patterns from the preference log ("this brand prefers 3:1 aspect ratios")
- A brand analyzer that periodically summarizes learned preferences into a readable digest
- Cross-brand synthesis: patterns by industry, geography, or audience

See [phase1-signal-intelligence-report.md](phase1-signal-intelligence-report.md) for what has actually shipped on top of this since, including the signal-based trend intelligence rebuild, SerpApi integration, and the Trend → Content → QA → Scheduling → Publishing chain.
