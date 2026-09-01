# GEO Engine MVP — Agent Build Specification

> Machine-actionable spec for an AI coding agent. Build in the order given. Do not skip acceptance criteria. Do not build engine adapters beyond ChatGPT and Gemini in the MVP.

---

## 0. Project meta

- **Project name:** geo-engine
- **Goal:** A multi-tenant platform that measures a business's visibility in AI-generated search answers across ChatGPT and Gemini, tracks it over time, and (later) diagnoses why a business is absent from specific answers.
- **MVP engines:** `chatgpt`, `gemini`. All other engines are OUT OF SCOPE for MVP.
- **Stack (required):**
  - Backend: Node.js, TypeScript, Express
  - ORM: Drizzle
  - DB: PostgreSQL
  - Queue/scheduler: BullMQ (Redis) or node-cron (agent may choose; default node-cron for MVP simplicity)
  - Frontend: Angular
- **Non-negotiable design principle:** measurement first. Do NOT implement content-rewriting features in MVP. Optimization is Phase 3, diagnostic-only.

---

## 1. Definitions (use these exact terms in code and schema)

- **Mention** — the client brand name appears anywhere in an engine's answer text.
- **Citation** — the engine's answer links to / references a client-owned URL.
- **Cited page** — a distinct client URL that was cited.
- **Share of Voice (SoV)** — `client_mentions / total_category_mentions` over a prompt set, as a percentage.
- **Average Position** — mean ordinal position of the client mention within answers where it appears (1 = first mentioned).
- **Run** — one execution of one prompt against one engine at one timestamp.
- **Snapshot** — an aggregated metrics record for a client at a point in time.
- **Adapter** — a module implementing the `EngineAdapter` interface for one engine.

---

## 2. Milestones, goals, and deliverables

Build milestones in order. Each milestone has explicit acceptance criteria that must pass before moving on.

### Milestone M1 — Schema & project skeleton

**Goal:** A running Express + TypeScript service connected to Postgres via Drizzle, with the full schema migrated.

**Deliverables:**

- Initialized TypeScript project, Express server with a `/health` endpoint returning `{ status: "ok" }`.
- Drizzle schema and a successful migration creating all tables in Section 3.
- `.env.example` documenting: `DATABASE_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PORT`.

**Acceptance criteria:**

- `GET /health` returns 200.
- Migration runs cleanly against a fresh Postgres database.
- All tables in Section 3 exist with the specified columns and foreign keys.

---

### Milestone M2 — Engine adapter interface + ChatGPT adapter

**Goal:** Prove the run loop against ONE engine end-to-end.

**Deliverables:**

- An `EngineAdapter` interface (Section 4).
- A `chatgpt` adapter calling the OpenAI API, returning the normalized `EngineResponse`.
- A function `runPrompt(promptId, engine)` that executes one prompt against one engine and persists a `runs` row plus raw response.

**Acceptance criteria:**

- Given a seeded client and prompt, calling `runPrompt(prompt, 'chatgpt')` stores a `runs` row with non-null `raw_response` and `text`.
- Adapter errors (rate limit, timeout) are caught and stored as a run with `status = 'error'` and an `error_message`; they never crash the process.

---

### Milestone M3 — Parser (mentions & citations)

**Goal:** Turn raw answers into structured mention/citation data.

**Deliverables:**

- A `parseResponse(run, client, competitors)` function using an LLM extraction call (NOT regex) that returns:
  - `clientMentioned: boolean`
  - `clientPosition: number | null` (ordinal within the answer)
  - `sentiment: 'positive' | 'neutral' | 'negative'`
  - `citations: { url: string, isClient: boolean }[]`
  - `competitorMentions: { name: string, position: number }[]`
- Persistence of parsed output into `mentions` and `citations` tables.

**Acceptance criteria:**

- For a controlled answer that names the client, `clientMentioned = true` and `clientPosition` is set.
- For an answer that does not name the client, `clientMentioned = false`.
- Citations pointing at a client domain are flagged `isClient = true`.
- Parser output is idempotent per run (re-parsing a run does not duplicate rows).

---

### Milestone M4 — Aggregation & snapshots

**Goal:** Compute the metrics that drive the dashboard.

**Deliverables:**

- An `aggregateClient(clientId, windowStart, windowEnd)` function computing SoV, average position, mentions, citations, cited pages, and per-engine breakdown.
- Writing an aggregated `snapshots` row per client per run cycle.

**Acceptance criteria:**

- SoV, average position, and per-engine counts match hand-computed values on a seeded fixture dataset.
- A snapshot row is created per aggregation cycle and is queryable as a time series.

---

### Milestone M5 — Gemini adapter

**Goal:** Validate the adapter abstraction by adding a second engine with zero changes to core loop code.

**Deliverables:**

- A `gemini` adapter implementing `EngineAdapter`, calling the Gemini API, returning normalized `EngineResponse`.
- Runner and parser work with `gemini` with no modification to their signatures.

**Acceptance criteria:**

- `runPrompt(prompt, 'gemini')` persists a valid run.
- Adding Gemini required NO edits to runner, parser, or aggregation logic — only a new adapter file and a registry entry.

---

### Milestone M6 — Scheduler

**Goal:** Automate recurring runs so the time series accumulates.

**Deliverables:**

- A scheduled job that, per active client, runs every prompt against every enabled engine, parses, and aggregates into a snapshot.
- Configurable cadence per client (`daily` | `weekly`).

**Acceptance criteria:**

- Triggering the scheduler produces runs, mentions, citations, and exactly one snapshot per client for that cycle.
- A failing engine call for one prompt does not abort the whole cycle.

---

### Milestone M7 — REST API for the dashboard

**Goal:** Expose aggregated data to the frontend.

**Deliverables (endpoints):**

- `GET /api/clients/:id/overview` → latest snapshot: visibility score, SoV, mentions, citations, cited pages, per-engine distribution.
- `GET /api/clients/:id/trends?metric=&from=&to=` → time series for a metric.
- `GET /api/clients/:id/prompts` → per-prompt latest results (mentioned?, position, engines).
- `GET /api/clients/:id/competitors` → competitive SoV table.

**Acceptance criteria:**

- Each endpoint returns correct data for a seeded client and 404s for unknown clients.
- All endpoints are tenant-scoped (a client cannot read another tenant's data).

---

### Milestone M8 — Angular dashboard

**Goal:** Visual parity with the reference SaaS dashboards.

**Deliverables:**

- Overview page: visibility gauge (0–100 + band), SoV card, referral/mentions cards, per-engine distribution bars.
- Trends page: line charts for mentions / citations / cited pages over time.
- Prompt table: prompt, mentioned?, position, per-engine.
- Competitors view: SoV comparison.

**Acceptance criteria:**

- Dashboard renders live from the REST API for a seeded client.
- Gauge band and score are derived from the documented formula (Section 5), not hardcoded.

---

## 3. Database schema (Drizzle / Postgres)

Implement these tables. Types are guidance; use appropriate Drizzle column types.

```
tenants
  id            uuid pk
  name          text
  created_at    timestamptz default now()

clients
  id            uuid pk
  tenant_id     uuid fk -> tenants.id
  name          text
  domain        text            -- canonical client domain, used for citation matching
  category      text            -- e.g. "accounting firm"
  location      text            -- e.g. "Chennai, IN"
  cadence       text default 'weekly'   -- 'daily' | 'weekly'
  created_at    timestamptz default now()

competitors
  id            uuid pk
  client_id     uuid fk -> clients.id
  name          text
  domain        text

prompts
  id            uuid pk
  client_id     uuid fk -> clients.id
  text          text
  intent        text            -- e.g. "commercial" | "informational" | "navigational"
  topic         text
  active        boolean default true
  created_at    timestamptz default now()

runs
  id            uuid pk
  prompt_id     uuid fk -> prompts.id
  engine        text            -- 'chatgpt' | 'gemini'
  status        text            -- 'ok' | 'error'
  text          text            -- normalized answer text
  raw_response  jsonb           -- full provider payload
  error_message text
  created_at    timestamptz default now()

mentions
  id            uuid pk
  run_id        uuid fk -> runs.id
  subject_type  text            -- 'client' | 'competitor'
  subject_name  text
  position      integer         -- ordinal within the answer, 1-based
  sentiment     text            -- 'positive' | 'neutral' | 'negative'

citations
  id            uuid pk
  run_id        uuid fk -> runs.id
  url           text
  is_client     boolean

snapshots
  id                uuid pk
  client_id         uuid fk -> clients.id
  captured_at       timestamptz default now()
  visibility_score  numeric      -- 0..100
  share_of_voice    numeric      -- 0..100 (%)
  avg_position      numeric
  total_mentions    integer
  total_citations   integer
  cited_pages       integer
  per_engine        jsonb        -- { chatgpt: {...}, gemini: {...} }
```

---

## 4. Engine adapter interface

Every engine implements this. The core loop depends ONLY on this interface.

```typescript
export type EngineName = 'chatgpt' | 'gemini';

export interface EngineCitation {
  url: string;
}

export interface EngineResponse {
  text: string; // normalized answer text
  citations: EngineCitation[]; // may be empty if engine returns none
  model: EngineName;
  raw: unknown; // full provider payload, stored as jsonb
  timestamp: string; // ISO 8601
}

export interface EngineAdapter {
  name: EngineName;
  run(prompt: string): Promise<EngineResponse>;
}
```

Rules:

- Adapters MUST normalize output to `EngineResponse`. No provider-specific shapes leak upward.
- Adapters MUST throw on hard failure; the runner catches and records `status='error'`.
- A registry maps `EngineName -> EngineAdapter`. Adding an engine = new adapter file + registry entry. Nothing else.

---

## 5. Visibility score formula (transparent, documented)

Compute per snapshot. Keep it explainable; expose it in the UI.

```
normalized_position = clamp(1 - (avg_position - 1) / 9, 0, 1)   // position 1 -> 1.0, position 10 -> 0.0
citation_rate       = total_citations / total_runs               // 0..1
sov_fraction        = share_of_voice / 100                       // 0..1

visibility_score = round(100 * (
  0.45 * sov_fraction +
  0.35 * citation_rate +
  0.20 * normalized_position
))

band:
  score >= 75 -> "High"
  score >= 45 -> "Medium"
  else        -> "Low"
```

Weights are configurable constants, not magic numbers scattered in code. Document them where the user can see them.

---

## 6. Parser extraction contract

The parser calls an LLM with a strict instruction to return ONLY JSON matching:

```json
{
  "clientMentioned": true,
  "clientPosition": 2,
  "sentiment": "positive",
  "citations": [{ "url": "https://example.com/page", "isClient": true }],
  "competitorMentions": [{ "name": "Rival Co", "position": 1 }]
}
```

Rules:

- Instruct the model to output JSON only, no prose, no markdown fences. Parse defensively (strip fences if present).
- Client/competitor identity is matched by name AND domain (pass both into the prompt).
- On parse failure, store the run as parsed with empty results and log; never crash.

---

## 7. Explicit non-goals (MVP)

- No Perplexity, Claude, Google AI Overviews, AI Mode, or Copilot adapters.
- No content rewriting or automated on-page changes.
- No SERP-scraping integrations.
- No billing/payments.
- No email reporting.

These are deferred to post-MVP phases and must not block the core loop.

---

## 8. Definition of done (MVP)

- A seeded tenant + client + prompt set runs on a schedule against ChatGPT and Gemini.
- Each cycle produces runs, parsed mentions/citations, and one snapshot per client.
- The Angular dashboard shows a live visibility gauge, SoV, trends, per-engine distribution, and a prompt table, all sourced from the REST API.
- Adding Gemini required no core-loop changes (proves the abstraction).
- All milestone acceptance criteria pass.
