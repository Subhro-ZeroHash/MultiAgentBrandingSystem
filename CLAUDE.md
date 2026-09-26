# CLAUDE.md

Guidance for AI assistants working in this repo.

## What this is

A pnpm + Turborepo monorepo holding **two products** that share a Brand Kit:
the Creative Content Agent (`apps/content-*`) and GEO visibility tracking
(`apps/geo-*`). Read [docs/architecture.md](docs/architecture.md) before making
structural changes and [docs/workflow.md](docs/workflow.md) before branching.

## Hard rules

1. **Never import a provider SDK outside `packages/ai/src/adapters/`.**
   Use `LlmService`, `ImageGenService`, `VideoGenService`, `WebSearchService`, or
   `AnswerEngineClient` from `@bmas/ai`.
   ESLint fails the build on violations.
2. **Everything is ESM.** Relative imports need explicit `.js` extensions
   (NodeNext resolution), including in the NestJS apps. This is not a typo.
3. **Schema changes require a generated migration.** Run `pnpm db:generate`;
   never hand-edit files in `packages/db/migrations/`.
4. **Two Postgres schemas are workstream-owned** (`content`, `geo`) and one is
   shared (`core`). Changing `core` affects both products.
5. **Every provider call records cost.** Adapters return `{ value, cost }`;
   persist `cost` to `core.cost_events`.
6. **New env vars go in three places**: `.env.example`, the app's
   `config/env.ts` Zod schema, and `turbo.json` `globalEnv` if builds read it.
7. **Auth is per route, not global.** Every non-public controller route needs
   `@UseGuards(JwtAuthGuard)` plus an ownership check on the brand it touches;
   a route without the guard is open to anyone.

## Model selection

Ask for a _role_, not a model name: `orchestrator`, `volume`, or `qa`. The
registry resolves roles to model ids from env. Don't hard-code a model string
in a service.

## Brand Brain system (Phase 1 complete)

The Content Agent now includes persistent context and learning:

- **Context Manager** (`packages/db/src/context/context-manager.ts`) is the single source of truth for brand knowledge
- Four retrieval functions feed task-specific context: trend research, generation, publishing, scheduling
- Brand preferences are append-only (never updated/deleted by user action) to preserve learning history
- Three layers of knowledge: Static (brand kit), Dynamic (recent activity), Learned (user feedback)
- Five tests pin critical invariants (approval confidence, regeneration floor, starvation prevention)

See [docs/brand-brain-system.md](docs/brand-brain-system.md) for full architecture, data model, bugs fixed, and roadmap.

## Deliberate gaps

Built since the scaffold: auth (custom JWT access + refresh tokens, bcrypt,
emailed reset codes), S3-compatible storage (MinIO locally, Cloudflare R2 in
prod), the Gemini image/LLM/video adapters, LTX video, Tavily/SerpApi search,
and a single-box EC2 deploy (`deploy.sh`, `ecosystem.config.cjs`, `nginx/`).

Still unbuilt on purpose: payments (the `credit_ledger` table exists, nothing
debits it) and observability (Sentry/PostHog). `FalImageAdapter` and
`OpenAiAnswerEngine` are `NotImplementedError` stubs. Model ids retire fast —
confirm a live id with a real call before changing a default in
`packages/ai/src/registry.ts`, and give every image model a row in
`packages/ai/src/pricing.ts` or its spend records as $0.

## Verifying a change

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

CI runs the same five steps; `pnpm format` fixes the first.

Tests are Vitest, named `*.test.ts` beside the code they cover, and extend the
shared base at `@bmas/config/vitest/node`. Coverage is deliberate rather than
broad: the pure functions where a silent regression is expensive (failure
classification, aspect-ratio mapping) and `composeBrief`, which is driven
through a fake `db` so it stays a unit test. Anything needing a real Postgres,
Redis, or provider does not belong in this suite. Add tests alongside new logic
worth protecting rather than assuming coverage exists.
