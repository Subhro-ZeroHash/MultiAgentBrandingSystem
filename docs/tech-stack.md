# Tech Stack — Multi-Agent Brand Marketing System

### Phase 1: Creative Content Agent

|            |              |
| ---------- | ------------ |
| **Status** | Draft v1.0   |
| **Date**   | 17 July 2026 |
| **Owner**  | Subhrajyoti  |

---

## Summary Table

| Layer                      | Choice                                    | Why                                                         |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Backend framework          | TypeScript + NestJS                       | DI modules map onto pipeline stages; clean adapter swapping |
| ORM                        | Drizzle                                   | Existing stack; raw-SQL escape hatch for ledger/job tables  |
| Database                   | PostgreSQL (Neon or Supabase)             | Relational core; brands, products, jobs, credits            |
| Queue                      | BullMQ + Redis (Upstash)                  | Long-running, retry-heavy generation jobs                   |
| Cache / locks / rate limit | Redis (same instance)                     | Idempotency keys, per-user limits                           |
| Frontend                   | Next.js 15 (App Router), PWA              | SSR marketing site + app in one deploy; mobile-first        |
| UI                         | Tailwind + shadcn/ui                      | Fast, consistent, mobile-responsive                         |
| Client state / data        | TanStack Query + Zustand                  | Server-state caching + light UI state                       |
| Realtime                   | SSE                                       | One-way job progress streaming                              |
| Orchestration / copy LLM   | Claude Haiku 4.5 (volume), Sonnet (QA)    | Existing stack; cheap at volume                             |
| Image gen (primary)        | Gemini image family (Google AI SDK)       | Product fidelity + on-image text + edits                    |
| Image edit / failover      | Flux Kontext (via fal.ai)                 | Targeted edits; provider redundancy                         |
| Bulk variants (optional)   | Seedream (via fal.ai)                     | Cheapest per-image for variant fan-out                      |
| Vision QA                  | Claude Sonnet or Gemini Flash             | Text/logo/brand-color readback                              |
| Image post-processing      | sharp                                     | Logo compositing, resize, watermark, export                 |
| Background removal         | @imgly/background-removal-node or rembg   | Clean messy phone photos before conditioning                |
| Storage / CDN              | Cloudflare R2                             | Zero egress on heavy image delivery                         |
| Frontend host              | Vercel                                    | Native Next.js target                                       |
| API + workers host         | Railway or Fly.io (Fly for Mumbai region) | Independent worker scaling; India latency                   |
| Auth                       | Better Auth (or Supabase Auth)            | Google OAuth + email, refresh rotation                      |
| Payments                   | Razorpay (India) + Stripe (intl)          | Dual-market; credit ledger                                  |
| Error monitoring           | Sentry                                    | Standard                                                    |
| Product analytics          | PostHog                                   | Activation/acceptance funnels                               |
| Cost telemetry             | Custom `generation_costs` table           | Per-user AI spend tracking (build your own)                 |
| CI/CD                      | GitHub Actions → Vercel + Railway/Fly     | Existing GH Actions muscle memory                           |
| Repo                       | pnpm + Turborepo monorepo                 | Shared types across client/server/worker                    |

---

## Backend

**TypeScript + NestJS + PostgreSQL (Drizzle) + BullMQ/Redis**

NestJS over bare Express because this is an agent system: dependency-injection modules map cleanly onto the pipeline stages (`BriefModule`, `ImageModule`, `QAModule`, `CopyModule`), and swapping a provider adapter becomes a token rebind rather than a refactor. If you'd rather stay on Express to match your Nirvanta muscle memory, that's defensible — just enforce the adapter boundary by convention.

- **ORM:** Drizzle — already your stack, and the credit-ledger / job tables want raw-SQL escape hatches.
- **Queue:** BullMQ + Redis — generation jobs are long-running and retry-heavy; the same async-job shape as your TTS pipeline.
- **Cache / locks:** same Redis instance — idempotency keys, per-user rate limits.

## Frontend

**Next.js 15 (App Router) + Tailwind + shadcn/ui, shipped as a PWA**

Next over Angular despite CalSync: you want SSR for the marketing site, edge-cached landing pages, and one deploy for site + app. Mobile-first PWA, no native app for the MVP.

- **State / data:** TanStack Query + Zustand.
- **Realtime:** SSE for job progress — simpler than websockets, and jobs are one-way progress streams.

## AI Layer

| Role                         | Choice                                               |
| ---------------------------- | ---------------------------------------------------- |
| Orchestration / Brief / Copy | Claude Haiku 4.5 (volume), Sonnet for QA judgment    |
| Image gen (primary)          | Gemini image family via Google AI SDK                |
| Image edit / failover        | Flux Kontext via fal.ai                              |
| Bulk variants (optional)     | Seedream via fal.ai                                  |
| Vision QA                    | Claude Sonnet or Gemini Flash                        |
| Image post-processing        | sharp (logo compositing, resize, watermark, export)  |
| Background removal           | @imgly/background-removal-node or rembg microservice |

All image calls go behind an `ImageGenService` interface. No provider SDK imports outside `/adapters`.

## Storage & Delivery

- **Cloudflare R2** — zero egress, which matters because you're serving lots of large images; this is not a small line item.
- Signed URLs, ~15 min TTL.
- Cloudflare Images or `sharp` at edge for thumbnails.

## Infra

- **Frontend:** Vercel.
- **API + workers:** Railway or Fly.io (Fly if you want a Mumbai region for India latency).
- **Postgres:** Neon or Supabase (Supabase also gets you auth + storage in one box if you want to compress scope).
- **Redis:** Upstash.

Avoid your EC2/PM2 pattern here — workers need to scale independently of the API, and hand-managed instances will bite you when generation load spikes.

## Auth, Payments, Ops

- **Auth:** Better Auth (or Supabase Auth if you take Supabase) — Google OAuth + email, refresh rotation.
- **Payments:** Razorpay (India) + Stripe (international), credit ledger as an append-only table.
- **Errors:** Sentry.
- **Analytics:** PostHog (funnels for activation / acceptance metrics).
- **Cost telemetry:** build your own — a `generation_costs` table logging tokens + image calls + provider per job. Non-negotiable from day one; nothing off-the-shelf tracks per-user AI spend the way your unit economics need.
- **CI/CD:** GitHub Actions → Vercel + Railway/Fly.

## Repo Structure

pnpm + Turborepo monorepo:

```
apps/
  web/        Next.js frontend + marketing site
  api/        NestJS API
  worker/     BullMQ generation workers
packages/
  db/         Drizzle schema + migrations
  ai/         Provider adapters + prompts (ImageGenService lives here)
  shared/     Zod schemas shared client <-> server
```

---

## Decisions Worth Contesting

The two choices to push back on if you disagree:

1. **R2 over S3** — driven by egress math on image delivery.
2. **Next over Angular** — SSR marketing site plus one deploy.

Everything else is swappable.
