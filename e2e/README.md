# Phase 1 acceptance suite

Checked-in end-to-end checks for the Brand Brain / Context Manager, the
signal-based trend intelligence pipeline, the leads/business-intelligence
system, and — the property that actually matters — that a user's action on
a trend or a lead becomes a `brand_preferences` row the Context Manager
surfaces on the next read.

## Why this isn't a vitest suite

`CLAUDE.md` is explicit: anything needing a real Postgres, Redis, or
provider does not belong in the workspace's unit test suites. This needs a
real Postgres and a running `content-api`. It lives here instead, run
manually or in a deploy pipeline's smoke-test step, not on every `pnpm test`.

## What it does and doesn't cover

Covers, deterministically, no external provider required:

- Context Manager returns the right shape and surfaces learnings
- Ownership isolation on trend research, intelligence, and AI research
- The signal/opportunity schema: raw signals independent of their
  opportunity, `signalCount`, provenance links
- The brand-memory loop: ignoring a trend opportunity or dismissing a lead
  writes a `topic` preference that reaches `getTrendContext().learnings`
- `automation_settings`' due-brand query shape

Does **not** run a live `trend-research` or `intelligence-research` job —
that needs a paid search provider (Tavily/SerpApi) and a paid LLM call,
neither guaranteed available to whoever runs this or reproducible in CI.
Every stage up to and including LLM synthesis was verified live during
development against the real dev stack; see the final implementation report
for that transcript, including a real bug this live testing caught (signals
were being lost when synthesis failed — fixed by persisting them in their
own transaction before synthesis runs, not after).

## Running it

```bash
pnpm infra:up              # postgres + redis + minio
pnpm db:migrate
pnpm db:seed                # creates dev-user / dev-brand
pnpm --filter @bmas/content-api dev   # leave running in another terminal

pnpm install                 # links e2e's workspace dependency on @bmas/db
npx tsx e2e/acceptance.mts
```

Exits non-zero if anything fails, so it's CI-usable as-is once a real
Postgres + a running `content-api` are available in that environment.
