# CLAUDE.md

Guidance for AI assistants working in this repo.

## What this is

A pnpm + Turborepo monorepo holding **two products** that share a Brand Kit:
the Creative Content Agent (`apps/content-*`) and GEO visibility tracking
(`apps/geo-*`). Read [docs/architecture.md](docs/architecture.md) before making
structural changes and [docs/workflow.md](docs/workflow.md) before branching.

## Hard rules

1. **Never import a provider SDK outside `packages/ai/src/adapters/`.**
   Use `LlmService`, `ImageGenService`, or `AnswerEngineClient` from `@bmas/ai`.
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

## Model selection

Ask for a _role_, not a model name: `orchestrator`, `volume`, or `qa`. The
registry resolves roles to model ids from env. Don't hard-code a model string
in a service.

## Deliberate gaps

Auth, payments, object storage, and observability are unbuilt on purpose — the
choices haven't been made. Look for `TODO(content)` and `TODO(geo)` markers.
The image adapters and two GEO engine adapters are stubs pending the provider
spike (PRD §Q4): confirm live model ids and pricing before filling them in
rather than guessing from training data.

## Verifying a change

```bash
pnpm typecheck && pnpm lint && pnpm build
```

There is no meaningful test suite yet; if you add logic worth protecting, add
tests alongside it rather than assuming coverage exists.
