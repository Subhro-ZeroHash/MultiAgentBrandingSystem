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
core     users, brands (Brand Kit), cost_events        <- shared, both owners review
content  products, product_images, generation_jobs,
         creative_assets, copy_packs, credit_ledger    <- content workstream
geo      tracked_prompts, competitors, probe_runs,
         mentions, visibility_snapshots                <- GEO workstream
```

Namespacing by schema means the two workstreams generate migrations against the
same database without colliding, while `core` stays an explicit shared surface.

`core.cost_events` is append-only and written by _every_ provider call in both
systems. Adapters return `{ value, cost }` together, so the cost row is hard to
forget - that's deliberate, per the PRD's "cost telemetry from day one".

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

## Deliberately deferred

The skeleton has no auth, payments, storage client, or observability wiring.
Those are real decisions (Better Auth vs Supabase, Razorpay + Stripe, R2 vs S3,
Sentry/PostHog) and stubbing them now would bake in a choice nobody has made.
Placeholders are marked `TODO(content)` / `TODO(geo)` at the call sites that
need them.
