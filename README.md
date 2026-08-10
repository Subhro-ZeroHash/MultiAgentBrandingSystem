# Brand Marketing Multi-Agent System

Two products, one Brand Kit, one repo. The Creative Content Agent now includes the **Brand Brain**—a persistent context and memory system that learns from user feedback and informs all future generations.

| System                     | What it does                                                                                                  | Apps                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Creative Content Agent** | Product photos + a structured request → poster/ad image + matching copy, informed by accumulated brand memory | `content-api`, `content-worker` |
| **GEO**                    | Measures how ChatGPT / Perplexity / Gemini / Claude describe the business                                     | `geo-api`, `geo-worker`         |
| **Brand Brain** ✨         | Persistent context, learned preferences, feedback capture, and audit trail for every brand                    | Part of content-api/worker      |

Both products read the same `core.brands` Brand Kit and share the provider-abstraction
layer, the database package, and the Zod contracts. The Brand Brain adds four new tables
(`brand_context`, `brand_preferences`, `automation_settings`, `context_snapshots`) to make brand knowledge persistent and queryable by the content generation pipeline.

## Layout

```
apps/
  web/             Next.js 15 — /studio (content) and /geo route groups
  content-api/     NestJS  — brand kit, products, generation intake
  content-worker/  BullMQ  — brief → image → QA → copy
  geo-api/         NestJS  — tracked prompts, visibility reads
  geo-worker/      BullMQ  — probe → analyse → roll-up
packages/
  ai/              Provider adapters + LlmService / ImageGenService / AnswerEngineClient
  db/              Drizzle schema (core | content | geo) + migrations
  shared/          Zod contracts and queue names shared client ↔ server
  config/          Shared tsconfig + ESLint
docs/              PRD, tech stack, architecture, workflow
```

## Getting started

Prerequisites: Node 22+ (see `.nvmrc`), Docker, pnpm via corepack.

```bash
corepack enable
pnpm install

cp .env.example .env          # fill in at least ANTHROPIC_API_KEY
pnpm infra:up                 # postgres + redis + minio
pnpm db:migrate               # apply migrations
pnpm db:seed                  # dev user + brand + sample GEO prompts

pnpm dev                      # all apps
```

The containers bind **5433** (Postgres) and **6380** (Redis), not the defaults —
a locally-installed Postgres on 5432 otherwise shadows the container and shows
up as a confusing authentication failure rather than a port clash.

`pnpm db:seed` is what makes the write paths usable before auth exists: the
APIs have no identity yet, so `POST /api/brands` needs a real `core.users` row
to reference (`DEV_OWNER_ID`, default `dev-user`).

Or run one workstream at a time:

```bash
pnpm --filter @bmas/geo-api --filter @bmas/geo-worker --filter @bmas/web dev
pnpm --filter @bmas/content-api --filter @bmas/content-worker --filter @bmas/web dev
```

Health checks: <http://localhost:4000/api/health> and <http://localhost:4100/api/health>.
The GEO one lists which answer engines have credentials configured.

## Commands

| Command              | Does                                               |
| -------------------- | -------------------------------------------------- |
| `pnpm dev`           | All apps in watch mode                             |
| `pnpm build`         | Build everything (Turbo respects package graph)    |
| `pnpm typecheck`     | `tsc --noEmit` across the workspace                |
| `pnpm lint`          | ESLint, including the provider-SDK import boundary |
| `pnpm format`        | Prettier write                                     |
| `pnpm db:generate`   | Generate a migration from schema changes           |
| `pnpm db:migrate`    | Apply pending migrations                           |
| `pnpm db:seed`       | Idempotent local dev data                          |
| `pnpm db:studio`     | Drizzle Studio                                     |
| `pnpm infra:up/down` | Docker Compose                                     |

## Working in parallel

Read [docs/workflow.md](docs/workflow.md) before your first branch. Short version:
own your `apps/` directories, coordinate on `packages/`, and never import a
provider SDK outside `packages/ai/src/adapters` — see
[docs/architecture.md](docs/architecture.md) for why.
