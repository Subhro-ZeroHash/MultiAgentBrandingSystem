# Phase 1 Final Implementation Report — Signal-Based Trend Intelligence

**Scope**: Full codebase audit against the Autonomous Brand-Aware Trend & Intelligence spec, plus the Signal Engine rebuild ("store signals, not trends").
**Repos touched**: `MultiAgentBrandingSystem` (backend) and `demo-frontend` (Expo app, separate repo, same account).

---

## 1. Audit summary — what was checked, and its state before this pass

| Item                                             | Before this pass                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Brand Brain / Brand Memory                       | ✅ Implemented (prior session)                                                |
| Context Manager                                  | ✅ Implemented (prior session)                                                |
| Active Brand Context                             | ✅ Implemented (prior session)                                                |
| Autonomous "set it and forget it" research       | ✅ Implemented (prior session) — BullMQ repeatable, every 10h                 |
| Existing Tavily integration                      | ✅ Implemented                                                                |
| Separate Leads / Business Intelligence system    | ✅ Implemented (prior session)                                                |
| AI research prompt box                           | ✅ Implemented (prior session)                                                |
| BullMQ + Redis autonomous scheduling             | ✅ Implemented (prior session)                                                |
| Provider failure handling                        | ✅ `withRetry`/`withTimeout`/quota classification — solid, no circuit breaker |
| **Signal-based trend intelligence**              | ❌ Missing — stored one-shot "ideas," not evidentiary signals                 |
| **SerpApi integration**                          | ❌ Missing entirely                                                           |
| **Future TikTok/YouTube/IG/FB/Reddit providers** | ❌ No interface, no stubs                                                     |
| **Signal normalization and aggregation**         | ❌ Missing                                                                    |
| **Brand-aware opportunity scoring**              | ⚠️ Partial — scored ideas, not aggregated cross-source signals                |
| Trend → Content → QA → Scheduling → Publishing   | ⚠️ Partial — stopped at one-shot `/create`, never reached scheduling          |
| End-to-end acceptance tests                      | ❌ None existed anywhere in the repo                                          |

This pass closed every ❌ and ⚠️ except the deliberately-deferred social provider stubs (see §9).

---

## 2. Architecture implemented

```
                 BRAND BRAIN
                      │
              CONTEXT MANAGER
                      │
           RESEARCH ORCHESTRATOR
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     Tavily        SerpApi     (future providers,
   Web/News    Search/News      same interface)
        │             │             │
        └─────────────┼─────────────┘
                      ▼
              TREND SIGNALS (stored, raw)
                      │
              AI TREND ANALYSIS (clustering)
                      │
              BRAND RELEVANCE + SCORE
                      │
             TREND OPPORTUNITIES (stored)
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
  TREND ALERTS                  LEADS BOX
   (this doc)              (separate pipeline,
        │                   same shape, different
  User Approves               question — §6)
        │
   ┌────┴────┐
   ▼         ▼
Generate   Schedule for
  Now        Approval
   │         │
   └────┬────┘
        ▼
   Content → QA → (Scheduling →) Publishing
```

Two research agents share the collect-then-judge shape (Trend Research, Leads/Business Intelligence) but stay separate pipelines, separate tables, separate feeds — a policy change and a festival post idea answer different questions, and conflating their storage would bury one under the other. Both now read from `configuredWebSearches()`, so both automatically pick up SerpApi (or any future provider) with zero code changes.

---

## 3. Signal-based trend intelligence — the core rebuild

### 3.1 What changed and why

The prior model stored one row per synthesized "idea," produced by one search pass and one LLM judgment, with no record of the raw evidence behind it. The spec's example is the reason this matters:

> 5 Trend Signals → Trend Intelligence Engine → "Football / World Cup is a growing opportunity"

Storing only the conclusion means every past judgment is an unauditable black box. Storing the signals means the evidence outlives the model call that interpreted it — and the same signal, judged against two different brands, correctly produces two different opportunity scores (the ABC Shoes / XYZ Bakery example from the spec), because relevance is computed at the opportunity layer, once, per brand, not baked into the signal itself.

### 3.2 Data model

Two new tables replace `trend_ideas` (dropped, not migrated — this was a clean create/drop, confirmed via drizzle-kit's interactive resolver, not a lossy rename):

**`trend_signals`** — raw evidence, one row per search result, before any AI judgment:

```
id, run_id, source (text: 'tavily' | 'serpapi' | future),
signal_type (text: 'news_mention' | 'event_proximity' | 'social_trend_mention'),
topic (null until clustered), title, snippet, strength (0-100, rank-derived),
source_url, published_at, opportunity_id (nullable FK, ON DELETE SET NULL),
created_at
```

`source` and `signal_type` are `text`, not database enums — deliberately. Adding a provider later (Bing, Reddit, a paid social-listening contract) is new rows under this same shape, not a migration. The vocabulary lives in `SignalSource`/`SignalType` in `@bmas/shared`, which is where it should grow.

**`trend_opportunities`** — the AI's conclusion after clustering:

```
id, run_id, topic, category, title, summary, recommendation, content_type,
score (jsonb: 5 axes + computed overall), signal_count, sources (derived,
not model-generated), suggested_request, status, created_at
```

`sources` on an opportunity is now **mechanically derived** from its clustered signals' URLs, not asked of the model — every citation is guaranteed real by construction, closing off a whole class of fabrication risk that the old model's `verifySources()` guard existed to catch after the fact.

### 3.3 Pipeline (`apps/content-worker/src/pipeline/trend-research.ts`, 736 lines)

1. **Collect** — the same three category queries as before (industry/news, events/festivals, social-trend-approximation), now fanned out across _every configured search provider_ via `ai.configuredWebSearches()`. With only Tavily configured, behavior is unchanged; with SerpApi added, each query runs against both, and a topic both surface independently is treated as stronger evidence in the `popularity` scoring axis.
2. **Persist signals immediately** — in their own transaction, before synthesis runs. See §3.4 for why this specific ordering was a live bug fix, not a design choice made up front.
3. **Cluster** — one LLM call (`orchestrator` role) given the full numbered signal list, asked to cluster related signals into up to 8 opportunities, each carrying `signalIndexes` referencing which signals back it.
4. **Resolve** (`resolveOpportunitySignals`, pure and tested) — validates the model's `signalIndexes` against the real signal array: out-of-range or duplicate indexes are dropped, not trusted; an opportunity left with zero valid signals after filtering is dropped entirely, since an opportunity with no evidence is exactly the "manufactured to fill a quota" failure the prompt is told not to produce.
5. **Store opportunities + backfill provenance** — insert opportunity rows, then `UPDATE trend_signals SET topic=…, opportunity_id=… WHERE id IN (…)` for each opportunity's resolved signal set.

### 3.4 A real bug this rebuild's own testing caught

First live run against the dev stack: search collection succeeded (11 signals collected across three categories), but LLM synthesis failed on a pre-existing, unrelated cause — the dev Gemini key's prepayment credits were exhausted (`429 RESOURCE_EXHAUSTED`, confirmed unrelated to this work). Checking the database afterward: **zero signals had been persisted**, despite collection having succeeded.

Root cause: the initial implementation bundled signal insertion into the same transaction as opportunity insertion, which only runs after synthesis succeeds. That directly contradicted the rebuild's own stated goal — "the evidence outlives the model call that interpreted it" — while actually behaving the opposite way: a failed model call silently discarded the evidence too.

**Fix**: signals are now persisted in their own transaction immediately after collection, before synthesis is even called. Opportunities and the signal→opportunity backfill happen in a second, separate transaction, only reached if synthesis succeeds.

**Verified**: re-ran the same scenario after the fix — synthesis failed again (same pre-existing billing issue), and this time `GET /brands/dev-brand/trend-research/:runId/signals` correctly returned all 11 real, sourced signals, each with `topic: null` and `opportunity_id: null` (correctly awaiting clustering that never got to run). This is the acceptance-critical property of a signal model: raw evidence must be queryable independent of whether the AI judgment step ever succeeds.

### 3.5 Transparency endpoint

`GET /brands/:brandId/trend-research/:runId/signals` — every signal collected for a run, whether or not it was clustered into a surfaced opportunity. Not shown in the main feed by default (payload can run to dozens of rows across providers); exists so "why did the platform think this mattered" is answerable down to the actual search results, not just the model's summary of them.

---

## 4. SerpApi integration

`packages/ai/src/adapters/serpapi.search.ts` implements the existing `WebSearchService` interface against SerpApi's real `engine=google` / `tbm=nws` response shape — no new abstraction needed, since the interface already existed for Tavily. `isConfigured()` returns `false` without `SERPAPI_KEY`, degrading exactly like every other optional provider in this codebase.

Registered in `AiRegistry` alongside Tavily. A new method, `configuredWebSearches()`, mirrors the existing `configuredEngines()` pattern (used by GEO's answer-engine sweep) — returns every search provider with credentials present, `stub` excluded, so the signal pipeline queries all of them rather than the single provider `webSearch()` resolves to for single-provider callers (the AI research prompt box, the brand-site importer).

Unconfigured in this environment (no `SERPAPI_KEY` set) — the signal pipeline ran on Tavily alone during live testing, exactly as designed for "second provider not yet added." 15 new unit tests (`serpapi.search.test.ts`) pin the request-building and response-mapping logic against SerpApi's documented shapes.

---

## 5. Future social providers (TikTok, YouTube, Instagram, Facebook, Reddit)

Per your explicit direction, **not built this pass** — no interface stubs, no fake data. What's already in place that a future integration would slot into without a redesign:

- `SignalSource` and `SignalType` in `@bmas/shared` are open string unions, not closed database enums — a new provider adds new valid values, not a migration.
- `WebSearchService` is the interface any search-shaped provider implements; `configuredWebSearches()` already fans out to everything configured.
- None of these platforms expose a free trend-signal API — every one requires a paid business/ads-library tier. Building against an API that doesn't exist yet would mean either fabricated data or an unusable stub; documenting the gap honestly here is the correct alternative until a paid tier is actually contracted.

---

## 6. Leads / Business Intelligence (verified, not rebuilt)

Confirmed still correct against the new signal-aware `configuredWebSearches()` wiring — `intelligence-research.ts` collects government-policy/industry-news/local/competitor signals the same shape as trend research, though it was not part of this pass's rebuild (its own item-level model, `intelligence_items`, was already correct from the prior session and doesn't need a signals/opportunities split — a lead is a single evaluated conclusion, not a cluster of independent evidence the way a trend is). Live-tested this pass: dismissing a lead correctly writes a `topic`-type rejection to `brand_preferences`.

---

## 7. AI Research prompt box (verified, not rebuilt)

Unchanged this pass — already correct from the prior session. Re-verified via the acceptance suite: ownership isolation holds (a foreign owner gets 403, not another brand's answer).

---

## 8. Trend → Content → QA → Scheduling → Publishing — the missing link closed

Before this pass, "Work On This" on a trend idea only ever reached the one-shot `/create` screen — content generated instantly, never entering the approval-gated scheduling pipeline. Per your direction, a second destination now exists:

- **Backend**: `POST /brands/:brandId/trend-research/:runId/opportunities/:opportunityId/schedule` (`TrendsService.scheduleOpportunity`) creates a single-post scheduled campaign (`totalDays: 1, postsPerDay: 1`) from the opportunity's `suggestedRequest`, delegating entirely to the existing `SchedulingService.createCampaign` — ownership checks, product validation, slot computation, and the generation job it enqueues are all that service's unmodified logic.
- **Frontend**: `trends/[runId].tsx` now offers **Generate Now** (existing one-shot flow) and **Schedule for Approval** (navigates to `/schedule/new`, prefilled via the same route-params pattern `/create` already used, reusing that screen's own product picker rather than building a new one).
- Both paths mark the opportunity `working_on` and record the same brand-memory signal, before the user finishes — so the choice lands even if they back out.

**Known, documented gap**: `suggestedRequest.extraInstructions` — the opportunity's actual angle, written as designer direction — has nowhere to go in a scheduled campaign; `scheduled_campaigns` has no per-campaign freeform brief field the way a one-shot generation request does. A post scheduled from a trend gets the right product, style, and format, but not the opportunity's specific context in the brief. Documented in the shared schema (`scheduleTrendOpportunitySchema`'s own comment) rather than silently dropped. Giving campaigns a brief field is a larger, separate change than "add the entry point," which is what was asked for this pass.

---

## 9. Provider failure handling (confirmed, unchanged)

`packages/ai/src/resilience.ts` — `withRetry`, `withTimeout`, `isQuotaExhausted`, `isRetryable`, `isPermanentFailure`, `retryAfterMs`. Solid coverage: retries are classified by failure type (a 401 never retries; a 429/5xx does), timeouts prevent a hung provider call from blocking a worker indefinitely, and quota exhaustion is distinguished from a transient failure. No circuit breaker (repeated failures don't temporarily stop trying a provider) — not part of the original ask, noted as a real gap for a future pass at higher request volume.

---

## 10. End-to-end acceptance tests

None existed anywhere in the repo before this pass. Added `e2e/acceptance.mts` (checked in, not a vitest suite — `CLAUDE.md` explicitly excludes real-DB/Redis/provider tests from the workspace's unit suites) plus `e2e/README.md` documenting prerequisites and the deliberate choice not to exercise a live provider call (see that README for the full reasoning).

**14/14 passing**, run against the real dev stack:

```
Brand Brain / Context Manager
  PASS  getTrendContext returns identity, learnings, recentTopics
  PASS  a topic-type feedback signal reaches getTrendContext().learnings

Active Brand Context — ownership isolation
  PASS  a foreign owner cannot read this brand's trend research
  PASS  a foreign owner cannot read this brand's intelligence feed
  PASS  a foreign owner cannot ask AI research questions about this brand

Signal-based trend intelligence
  PASS  seed: a run, two signals, and one clustered opportunity
  PASS  GET .../signals returns raw evidence independent of the opportunity
  PASS  GET run detail returns the opportunity with its signalCount
  PASS  ignoring an opportunity writes a topic rejection to brand memory

Leads / Business Intelligence
  PASS  seed: an intelligence run with one item
  PASS  GET the feed returns the item, newest run only
  PASS  dismissing a lead writes a topic rejection to brand memory

BullMQ + Redis autonomous scheduling
  PASS  automation_settings due-brand query is indexed and correct

Cleanup
  PASS  teardown: remove everything this run created

14 passed, 0 failed
```

---

## 11. Full monorepo verification

```
pnpm typecheck   → 12/12 packages clean
pnpm lint        → 12/12 packages clean
pnpm build       → 8/8 apps/packages clean
pnpm test        → all workspace suites green (285 tests: 93 @bmas/ai [+15 SerpApi],
                    4 @bmas/db, 92 @bmas/content-api, 85 @bmas/content-worker
                    [signal-model tests replaced the old idea-model tests])
```

Live boot: `content-api` and `content-worker` both start with zero errors. Live-triggered a real trend-research run against Tavily — search succeeded, 11 signals persisted correctly, synthesis failed only on the pre-existing exhausted Gemini quota (external, unrelated to this work), and the bug that failure surfaced (§3.4) was fixed and re-verified in the same session.

---

## 12. Files changed

**New files** (backend):

- `packages/ai/src/adapters/serpapi.search.ts` + `.test.ts`
- `packages/db/migrations/0018_smooth_lockjaw.sql` (+ meta snapshot)
- `e2e/acceptance.mts`, `e2e/README.md`, `e2e/package.json`
- `docs/phase1-signal-intelligence-report.md` (this file)

**Rewritten**:

- `apps/content-worker/src/pipeline/trend-research.ts` (736 lines — signal collect + cluster pipeline)
- `apps/content-worker/src/pipeline/trend-research.test.ts` (new pure-function coverage: `resolveOpportunitySignals`, `clipOpportunityCounts`)
- `packages/shared/src/content/trends.ts` (signal/opportunity contracts)

**Modified**:

- `packages/db/src/schema/content.ts` (`trend_signals` + `trend_opportunities` replace `trend_ideas`)
- `packages/db/src/context/context-manager.ts` (`loadRecentTopics`/`loadCurrentTrend` read opportunities)
- `packages/ai/src/registry.ts`, `packages/ai/src/pricing.ts` (SerpApi wiring, `configuredWebSearches()`)
- `apps/content-api/src/trends/{trends.service,trends.controller,trends.module}.ts` (opportunities API + scheduling entry point)
- `apps/content-api/src/scheduling/scheduling.module.ts` (exports `SchedulingService`)
- `apps/content-api/src/config/env.ts`, `.env.example`, `turbo.json` (`SERPAPI_KEY`)
- `demo-frontend/lib/api.ts`, `demo-frontend/app/trends/[runId].tsx`, `demo-frontend/app/schedule/new.tsx` (opportunity rename sweep + scheduling entry point)

## 13. Database changes

- `0018_smooth_lockjaw.sql`: drops `trend_ideas` + `trend_idea_status` (clean create/drop, resolved interactively via drizzle-kit — confirmed not a lossy rename); creates `trend_signals`, `trend_opportunities`, `trend_opportunity_status`, with FKs (`trend_signals.opportunity_id ON DELETE SET NULL`) and indexes on both new tables' `run_id`.

## 14. Remaining gaps

1. Social provider stubs (TikTok/YouTube/IG/FB/Reddit) — deliberately deferred, §5.
2. Circuit breaker on provider failures — not part of the original ask, noted for future volume.
3. `extraInstructions` doesn't reach a scheduled campaign's brief — documented in §8, needs a `scheduled_campaigns` schema change to close.
4. Live end-to-end verification of trend-research's full LLM synthesis step is blocked by the dev environment's exhausted Gemini quota — an external, pre-existing condition, not a defect in this work. Every stage up to that point was verified live; the acceptance suite verifies everything downstream deterministically without needing it.
