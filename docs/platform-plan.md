# Platform Plan — from two tools to one system

Status: proposal, 2026-08-02. Supersedes nothing; extends
[architecture.md](architecture.md).

## The thesis

Today we have two good tools that don't know about each other. Content
generation makes assets. GEO measures AI-answer visibility. A customer using
both gets no more than the sum of the parts, because nothing carries an
understanding of the business between them.

The product is the loop, not the agents:

```
        ┌──────────────── Brand Context (versioned, provenance-tracked) ─────────────┐
        │                                                                            │
        ▼                                                                            │
   Strategist ──▶ Marketing Plan ──▶ Initiatives ──┬──▶ Content pipeline ──▶ posts   │
   (agent)        goals + pillars                  │                          │      │
        ▲                                          └──▶ GEO prompt set ──▶ probes    │
        │                                                                     │      │
        └──────────── Analyst ◀── measurement (two clocks) ◀──────────────────┘      │
                         │                                                           │
                         └── learned facts ──────────────────────────────────────────┘
```

Everything below is in service of closing that loop honestly.

---

## What I'd change about the original sketch

The shape (onboard → plan → execute → measure) is right. Five corrections
before we build it.

### 1. Most of these are workflows, not agents

An _agent_ is a model-driven loop that chooses its own next step. A _workflow_
is a pipeline we wrote, with LLM calls at some steps. They cost and fail very
differently.

Almost everything we've described is a workflow, and both existing workers are
already correctly built as workflows (`brief → image → QA → copy`,
`probe → analyse → roll-up`). That is a strength. Do not convert them.

Reserve real agentic loops for genuinely open-ended work:

| Component        | Actually is                        | Why                                                     |
| ---------------- | ---------------------------------- | ------------------------------------------------------- |
| Onboarding       | workflow (crawl → extract → synth) | Fixed steps, known output shape                         |
| **Strategist**   | **agent** — tool loop              | Must explore: read site, GEO data, competitors, decide  |
| **Researcher**   | **agent** — tool loop              | Open-ended: why do answers cite X and not us?           |
| Content pipeline | workflow (exists)                  | Deterministic, cost-sensitive, high volume              |
| Publisher        | workflow                           | It's an API call with a retry policy                    |
| GEO pipeline     | workflow (exists)                  | It's a measurement instrument; non-determinism is a bug |
| Analyst          | workflow + one LLM narration step  | Metrics are computed, not reasoned                      |
| Brand critic     | single LLM-as-judge call           | One decision, no loop                                   |

Two agents, five workflows. If we call all seven "agents" we will spend months
building loop infrastructure we don't need, and our unit costs will be
unpredictable. The multi-agent framing is a good _product_ story and a bad
_implementation_ default.

### 2. The measurement loop has two clocks — don't merge them

"GEO tracks analytics after each campaign" doesn't hold up. GEO measures what
answer engines say about a brand. That moves on the timescale of weeks to
months and is driven by web presence, citations, listings, and reviews — **not
by an Instagram carousel posted on Tuesday.** If we show a manager or a
customer "we posted, our GEO score rose," we're claiming causality we cannot
support, and the first person who checks will find the confound.

Model it as two loops with different periods:

| Loop     | Period    | Measures                                        | Source                     | Steers                 |
| -------- | --------- | ----------------------------------------------- | -------------------------- | ---------------------- |
| **Fast** | days      | reach, engagement, saves, clicks, post velocity | Instagram Graph API        | content tactics        |
| **Slow** | 2–4 weeks | presence, position, share of voice, citations   | GEO probes (already built) | strategy & positioning |

GEO's real output isn't "post more." It's _"you are absent from 6 of 9
discovery prompts; the answers that beat you cite these four sources; you
appear on none of them."_ That drives a strategy revision — get listed, get
reviewed, publish comparison content — which then drives content work. The
causal chain is `GEO → strategy → content`, not `content → GEO`.

Attribution rule we should adopt now: never claim a GEO delta was caused by a
campaign. Report them side by side on one timeline, annotate campaigns as
markers, and let the correlation be visible without asserting it. That is both
more honest and, oddly, more credible in a demo.

### 3. The questionnaire should be a confirmation, not an interrogation

SMB owners abandon long forms. We already have a better input: the colleague's
branch ships `core.brand_site_profiles` — website crawl and extraction.

Onboarding should be: **URL + Instagram handle → we derive the profile → the
owner confirms or corrects six things.** The questionnaire's job is to capture
only what cannot be inferred: goals, budget/effort ceiling, geography, things
we must never say, and what "success" means to them. Everything else we read.

That's a better product _and_ less work, because half of it exists.

### 4. A goal that isn't a metric is decoration

If the Strategist can emit "increase brand awareness," the plan is unfalsifiable
and the whole system is theatre. Every goal must compile to a series we already
compute, or the planner must rewrite it until it does:

```
goal := { metric, target, horizon, baseline, scope }
metric ∈ { geo_score, presence_rate, share_of_voice, average_position,
           citation_rate, posts_published, engagement_rate, reach }
```

The planner's output is validated against this enum by code, not by prompt.
Anything that doesn't compile gets rejected and retried. This single constraint
is what makes the plan reviewable, the progress chart real, and replanning
possible.

### 5. Build the context layer as a record and a function, not a platform

"Context layer" invites building infrastructure first. Resist. It is:

- one versioned table (`core.brand_context`), and
- one function, `assembleContext(brandId, task)`, that returns a typed,
  token-budgeted bundle for a given consumer.

That's a few hundred lines. Vector search, embeddings, and a retrieval service
are a Phase 4 conversation, and only if the corpus outgrows a prompt window.
Ship the record first; every agent reading the same record is 90% of the value.

---

## Design

### Brand Context — the spine

One row per brand per version, immutable once published. Agents pin the version
they used, so we can always answer "what did the system believe when it decided
this?"

```
core.brand_context
  id, brand_id, version, status(draft|active|superseded)
  identity      jsonb   name, tagline, category, founded, story
  offerings     jsonb   products/services, price band, hero items
  audience      jsonb   segments, geography, language
  positioning   jsonb   differentiators, proof points, competitive set
  constraints   jsonb   never-say list, claims we can't make, compliance
  voice         jsonb   tone, vocabulary, banned phrases
  facts         jsonb[] { key, value, source, confidence, observed_at }
  created_at, published_at
```

`facts[]` is the important part. Every assertion carries **provenance**:

| source         | Example                                         |
| -------------- | ----------------------------------------------- |
| `onboarding`   | Owner said the goal is weekend footfall         |
| `site_crawl`   | Menu lists 40 items; 3 locations                |
| `social`       | Posts 2×/week, best engagement on food reels    |
| `geo_observed` | Answer engines describe us as "budget-friendly" |
| `human_edit`   | Owner corrected the category                    |

Provenance is what lets the context **self-update from measurement** — that's
the outer arrow in the diagram — and what lets us show a customer _why_ we
believe something. `geo_observed` facts are especially valuable: how the
internet's AI describes you is often not how you describe yourself, and that
gap is a genuine insight we can sell.

### Plan — a new schema, owned by whoever builds it

Keep it out of `core` so it doesn't become a third contested surface.

```
plan.marketing_plans   brand_id, version, context_version, status,
                       positioning, pillars[], channel_mix, cadence,
                       geo_themes[], rationale, created_by_agent, model
plan.goals             plan_id, metric, target, baseline, horizon, scope,
                       status(on_track|at_risk|met|missed), current_value
plan.initiatives       plan_id, goal_ids[], kind(content|geo|listing),
                       spec jsonb, cadence, status
plan.decisions         brand_id, at, actor, decision, evidence jsonb
```

`plan.initiatives` is the bridge — the only place the plan becomes work.
A `kind: 'content'` initiative compiles to content generation jobs; a
`kind: 'geo'` initiative compiles to rows in `geo.tracked_prompts`. **The plan
literally decides what GEO measures.** That is the moment the two products stop
being two products.

`plan.decisions` is append-only and is what makes the system explainable — and
what the next planning cycle reads so it doesn't relitigate settled calls.

### Coordination — events on the queue we already have

No Temporal, no LangGraph, no new orchestration dependency. Add an append-only
domain event log and a dispatcher that maps events to BullMQ jobs:

```
core.events   brand_id, type, payload, occurred_at, processed_at

brand.onboarded      → strategist.plan
plan.published       → initiatives.compile
initiative.created   → content.generate | geo.prompts.sync
campaign.completed   → analyst.summarise
snapshot.computed    → analyst.evaluate_goals
goal.at_risk         → strategist.replan
context.drifted      → strategist.replan
```

Loose coupling, zero new infrastructure, and a replayable history of everything
the system did. BullMQ stays the transport; the event log is the record.

---

## Phases

Sized for two people. Each phase ships something demonstrable.

### Phase 0 — Merge and consolidate _(~1 week, blocking)_

Nothing new. `feature/content-gen` and `geo/engine-mvp` both edit
`packages/ai/`, `queues.ts`, `registry.ts`, and `core.ts`; both independently
created `packages/ai/src/adapters/gemini.llm.ts`. That conflict compounds every
week we wait, and **everything below assumes a single trunk.**

- Resolve the duplicate Gemini adapter (one implementation, agreed interface)
- Land both branches on `main`; agree the `core` review rule in practice
- One `pnpm dev` that brings up both products; one seed script; one demo brand
- Green `pnpm typecheck && pnpm lint && pnpm build` on trunk

**Demo:** both products running side by side on one database.

### Phase 1 — Context layer _(~2 weeks)_

- `core.brand_context` with provenance; `assembleContext(brandId, task)`
- Onboarding: URL + handle → derived profile → 6-question confirmation
- Refactor **both** pipelines to read context instead of ad-hoc brand fields
- Backfill existing brands

**Demo:** onboard a real business in under three minutes; show the same context
object driving a caption and a GEO analysis. Both products get better and we
have added no agents.

### Phase 2 — Strategist and goals _(~2–3 weeks)_

- `plan` schema; goal→metric compiler with hard validation
- Strategist as a genuine tool-loop agent (`orchestrator` role) with tools:
  `read_context`, `read_geo_snapshots`, `read_competitors`, `read_performance`,
  `propose_plan`
- Plan review UI — a human approves before anything executes
- `plan.decisions` logging

**Demo:** onboard → a real plan with measurable goals, pillars, and a rationale
you can argue with.

### Phase 3 — Close the loop _(~2 weeks)_

- `core.events` + dispatcher
- Initiative compiler: content initiatives → generation jobs; **GEO initiatives
  → tracked prompts derived from the plan's themes**
- Analyst: goal progress from snapshots + post metrics, narrated
- Timeline view: GEO series with campaign markers, correlation shown, causation
  not claimed

**Demo:** the full loop, end to end, on one screen.

### Phase 4 — Learning and the fast clock _(~2–3 weeks)_

- Instagram insights ingestion → fast-loop metrics
- Performance facts written back into context (`source: 'social'`)
- Drift detection → `goal.at_risk` → automatic replan proposal (human-approved)
- Researcher agent: "why do answers cite these sources and not us?"

### Phase 5 — The deferred decisions

Auth, object storage, observability, payments, per-brand budget caps. These are
listed last but **auth and storage become blocking during Phase 3** if we want
anyone outside the team to touch it. Decide them by end of Phase 2.

---

## Risks

| Risk                                                            | Mitigation                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Merge debt compounds and Phase 1 starts on two divergent trunks | Phase 0 is blocking. Do it first, this week.                          |
| We claim campaigns caused GEO movement                          | Two clocks; markers not attribution; state the limitation in the UI.  |
| "Agent" everywhere → unpredictable cost and latency             | Two agents only; everything else is a workflow. Enforce in review.    |
| Strategist emits pretty, unmeasurable plans                     | Goal→metric compiler rejects non-compiling goals in code.             |
| Context layer becomes a six-week infrastructure project         | One table, one function. No retrieval service before Phase 4.         |
| Two people, ~3 months, three workstreams                        | Orchestration needs a named owner before Phase 2 or it will stall.    |
| Provider spend scales with brands × prompts × engines           | `core.cost_events` exists; add per-brand caps before any pilot.       |
| Answer-engine terms/pricing shift under us                      | Adapter boundary already isolates this; re-verify at each phase gate. |

## Open decisions

1. **Who owns `plan`/orchestration?** It touches both products. Unowned, it stalls.
2. **How autonomous is replanning?** Recommend: propose, never auto-apply, until we've seen 20 plans.
3. **Is GEO a feature or a product?** It can be sold standalone. That changes packaging and possibly the roadmap order.
4. **Human-in-the-loop on publishing?** Recommend yes, until brand-critic rejection rates are known.
5. **Auth/storage choices** — needed by Phase 3.

## Where to start

Phase 0, then `core.brand_context`. The context record is the highest-leverage
object in the system: it makes both existing products better on its own, and it
is the thing every later agent reads and writes. Build it before any new agent.
