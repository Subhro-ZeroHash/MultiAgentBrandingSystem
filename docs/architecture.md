# Architecture

## The one rule

**No product code imports a provider SDK.** `@anthropic-ai/sdk`, `@google/genai`,
`@fal-ai/client`, and `openai` may only be imported inside
`packages/ai/src/adapters/`. Everything else goes through an interface:

| Interface            | Used by            | Adapters                                                                                   |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `LlmService`         | both systems       | `AnthropicLlmAdapter`                                                                      |
| `ImageGenService`    | content generation | `GeminiImageAdapter`, `FalImageAdapter`                                                    |
| `AnswerEngineClient` | GEO                | `ClaudeAnswerEngine`, `PerplexityAnswerEngine`, `OpenAiAnswerEngine`, `GeminiAnswerEngine` |

`AiRegistry` (`packages/ai/src/registry.ts`) is the only place that decides
which adapter serves which operation, and it is built from environment
variables. Swapping a provider is a config change, never an edit in a service.

This is enforced by ESLint (`no-restricted-imports` in
`packages/config/eslint/base.mjs`), so a violation fails CI rather than review.

Why it matters: model releases, pricing, and policy all move faster than this
codebase will. The PRD's provider recommendations are explicitly marked
"verify before committing" - the abstraction is what makes re-verifying cheap.

## Model roles, not model names

Code asks for a _role_; the registry resolves it to a model id:

| Role           | Default            | Used for                                 |
| -------------- | ------------------ | ---------------------------------------- |
| `orchestrator` | `claude-opus-4-8`  | Brief composition, GEO answer analysis   |
| `volume`       | `claude-haiku-4-5` | Per-platform copy fan-out                |
| `qa`           | `claude-sonnet-5`  | Vision QA readback on rendered creatives |

Override per environment with `LLM_MODEL_ORCHESTRATOR` / `_VOLUME` / `_QA`.
The `volume` default follows the PRD's cost reasoning; `orchestrator` defaults
to the strongest model because the GEO analyser is the measurement instrument
and errors there corrupt every downstream score.

## Data model

Three Postgres schemas in one database:

```
core     users, brands (Brand Kit), cost_events, brand_site_profiles  <- shared, both owners review
content  products, product_images, generation_jobs, creative_assets,
         copy_packs, credit_ledger, brand_context, brand_preferences,
         automation_settings, context_snapshots, trend_research_runs,
         trend_signals, trend_opportunities, intelligence_runs,
         intelligence_items, ai_research_queries                      <- content workstream
         [Brand Brain tables marked with ✨]
geo      tracked_prompts, competitors, probe_runs, mentions,
         visibility_snapshots                                        <- GEO workstream
```

Namespacing by schema means the two workstreams generate migrations against the
same database without colliding, while `core` stays an explicit shared surface.

`core.cost_events` is append-only and written by _every_ provider call in both
systems. Adapters return `{ value, cost }` together, so the cost row is hard to
forget - that's deliberate, per the PRD's "cost telemetry from day one".

### Brand Brain tables

Four tables (marked ✨ above) implement persistent context and learning:

| Table | Purpose | Lifespan |
|-------|---------|----------|
| `brand_context` | Static brand kit: goals, positioning, pillars, competitors, products | Until user edits |
| `brand_preferences` | Append-only feedback log: rejections, regenerations, edits, approvals | Forever (audit trail) |
| `automation_settings` | Publishing policy: auto-publish flag, posting times, research cadence | Until user changes |
| `context_snapshots` | Audit log: what context each generation saw | With the generating job |

This is the **Brand Brain**: a persistent knowledge base that transforms the content
agent from stateless to learning. Every generation that uses brand context records
a snapshot; every user action (approve, reject, regenerate) records a preference with
confidence scoring. The next generation queries this accumulated knowledge when
composing briefs, making content progressively better informed. See
[docs/phase1-signal-intelligence-report.md](phase1-signal-intelligence-report.md)
for the full audit and the signal-based trend intelligence rebuild.

### Signal-based trend intelligence

`trend_signals` stores raw, unfiltered search evidence — one row per result a
search provider actually returned, before any AI judgment runs. `trend_opportunities`
stores the AI's conclusion after clustering related signals and scoring them against
one specific brand. The split matters: storing only a synthesized "idea" (the old
model) means every past judgment is an unauditable black box; storing the signals
means the evidence outlives the model call that interpreted it, and the same signal
judged against two different brands correctly produces two different scores.

`trend_signals.source` and `.signal_type` are `text`, not database enums — adding a
search provider (Tavily today, SerpApi as the second, more later) is new rows under
this shape, not a migration. See
[docs/phase1-signal-intelligence-report.md](phase1-signal-intelligence-report.md) §3
for the full pipeline and a real bug this design caught live (signals were being
silently discarded when LLM synthesis failed, because they were originally inserted
in the same transaction as the opportunities — fixed by persisting signals
independently, before synthesis runs).

## Async job model

Generation and probing are long-running and retry-heavy, so both are queued
(BullMQ + Redis) rather than served inline:

```
content-api  --content-generation-->  content-worker  (brief -> image -> QA -> copy)
geo-api      --geo-probe----------->  geo-worker      (ask engine -> analyse -> store)
             --geo-rollup---------->  geo-worker      (aggregate -> visibility_snapshots)
```

Queue names and job payload schemas live in `@bmas/shared` so an API can enqueue
work a worker in a different app consumes without either hard-coding a string.
Note that BullMQ rejects `:` in queue names and custom job ids - it namespaces
its own Redis keys with that character - so the separator is `-` throughout.

Two conventions worth keeping:

- **Idempotency keys.** Content generation requires an `Idempotency-Key` header
  and uses it as the BullMQ job id; GEO derives a job id from
  `prompt-engine-hour`. A retried request never double-charges a provider.
- **Graceful drain.** Workers `close()` on SIGTERM so a deploy never abandons a
  job that has already been paid for.

## GEO scoring

`computeGeoScore` in `packages/shared/src/geo/visibility.ts` is the single
definition of the headline number, weighted presence 45 / position 20 /
share-of-voice 20 / citations 15. Presence dominates because an SMB that never
appears cares about showing up before it cares about ranking.

`probe_runs.answer_text` is retained so mentions can be re-derived when the
analyser prompt changes - re-scoring history costs nothing but LLM tokens, and
never a re-probe. Treat edits to the analyser prompt
(`apps/geo-worker/src/pipeline/analyze.ts`) as a methodology change: re-run
against stored answers and compare before shipping.

## Brand Brain: Context Manager pattern

The **Context Manager** (`packages/db/src/context/context-manager.ts`) is the single source of truth
for assembling and recording brand knowledge. It exports four task-specific retrieval functions:

### Context assembly functions

- **`getTrendContext(db, brandId)`** — Used by trend research and the leads/intelligence pipeline; returns goals, competitors, positioning, recent topics, learned preferences
- **`getContentContext(db, brandId, {includeTrend})`** — Used by generation pipeline; returns full brand kit, learnings, rejected patterns
- **`getPublishingContext(db, brandId)`** — Used by publishing; returns automation settings, posting preferences, recent history
- **`getCampaignContext(db, brandId, campaignId)`** — Used by scheduling; returns campaign-scoped status

Each function is curated for its use case: trend research doesn't need every visual style preference,
and publishing doesn't need content pillars. This keeps prompts focused and queryable.

### Feedback recording functions

- **`recordContextSnapshot(db, input)`** — Logs "what the agent was handed" for auditing and future analysis
- **`recordFeedbackSignal(db, input)`** — Turns user actions (approve/reject/regenerate/edit, and — since the
  trend/leads rebuild — ignore/save/schedule on a trend opportunity or a lead) into `brand_preferences` rows
  with confidence scoring. A `type` override lets a caller file a row under a specific dimension (e.g. `'topic'`)
  regardless of which `kind`'s confidence weight it borrows.

Rejections and regenerations always reach prompts (confidence ≥ 0.4); approvals alone do not (0.25 confidence, below the prompt floor).
This prevents a single approval from displacing a real measured finding.

For detailed documentation, see [docs/phase1-signal-intelligence-report.md](phase1-signal-intelligence-report.md).

## Deliberately deferred

The skeleton has no auth, payments, storage client, or observability wiring.
Those are real decisions (Better Auth vs Supabase, Razorpay + Stripe, R2 vs S3,
Sentry/PostHog) and stubbing them now would bake in a choice nobody has made.
Placeholders are marked `TODO(content)` / `TODO(geo)` at the call sites that
need them.

TikTok/YouTube/Instagram/Facebook/Reddit signal providers are deferred the
same way: none exposes a free trend-signal API, and building against one that
doesn't exist would mean fabricated data. `SignalSource`/`SignalType` in
`@bmas/shared` are open string unions specifically so adding one later, once a
paid tier is contracted, is new rows under the existing `trend_signals` shape,
not a redesign.
