# Working in parallel

Two people, one repo, two products. This document is the contract that keeps
that from hurting.

## Branches

`main` is protected and always deployable. Everything else is a short-lived
branch off `main`:

```
geo/<topic>        e.g. geo/probe-scheduler
content/<topic>    e.g. content/gemini-adapter
shared/<topic>     e.g. shared/brand-kit-locale
```

Rebase on `main` before opening a PR. Squash-merge, delete the branch.

## Ownership

| Area                                          | Owner                            |
| --------------------------------------------- | -------------------------------- |
| `apps/geo-api`, `apps/geo-worker`             | GEO                              |
| `apps/content-api`, `apps/content-worker`     | Content                          |
| `packages/db/src/schema/geo.ts`               | GEO                              |
| `packages/db/src/schema/content.ts`           | Content                          |
| `packages/shared/src/geo/`                    | GEO                              |
| `packages/shared/src/content/`                | Content                          |
| `apps/web/src/app/(geo)/`                     | GEO                              |
| `apps/web/src/app/(studio)/`                  | Content                          |
| **Everything else in `packages/`, infra, CI** | **Both — needs a second review** |

`.github/CODEOWNERS` encodes this so GitHub requests the right reviewer
automatically. Update the placeholder handles in that file before the first PR.

Working only inside your own directories means merge conflicts should be rare.
When you need something from the shared surface, open a `shared/` PR for that
change _first_, get it merged, then build on it — this avoids the pattern where
a large feature branch quietly rewrites a shared contract.

## Database migrations

Both workstreams migrate the same database, separated by Postgres schema.

```bash
# after editing packages/db/src/schema/{geo,content}.ts
pnpm db:generate      # writes packages/db/migrations/<timestamp>_<name>.sql
pnpm db:migrate       # applies locally
```

`db:generate` uses the drizzle-kit CLI. `db:migrate` deliberately does **not** —
it runs Drizzle's programmatic migrator from the built output
(`packages/db/src/migrate.ts`), so the same command works locally, in CI, and in
a deploy step without dev dependencies.

Rules:

1. **Commit the generated SQL.** Never hand-edit it; regenerate instead.
2. **One migration per PR.** Two migrations racing to `main` is the one merge
   conflict this layout can't prevent — if the other branch lands first, rebase
   and regenerate.
3. **Touching `core`?** That's a `shared/` PR with both reviewers.
4. **Additive first.** Prefer adding a nullable column over changing one; the
   other workstream's worker may be running against the old shape.

## Environment variables

Every new variable goes in `.env.example` with a comment explaining what breaks
without it, and into the relevant app's `config/env.ts` schema so the process
refuses to start rather than failing on the first request that needs it.

## Definition of done for a PR

- `pnpm typecheck && pnpm lint && pnpm build` passes
- Migration generated and committed if the schema changed
- New env vars documented in `.env.example`
- No provider SDK imported outside `packages/ai/src/adapters` (CI enforces this)
- Shared-surface changes flagged to the other owner

## Open decisions

These are deliberately unbuilt — pick them up as their own `shared/` PRs:

| Decision                 | Notes                                                           |
| ------------------------ | --------------------------------------------------------------- |
| Auth provider            | Better Auth vs Supabase Auth; affects `core.users`              |
| Object storage client    | S3 SDK against MinIO locally, R2 in prod                        |
| Payments + credit grants | Razorpay (India) + Stripe; ledger table already exists          |
| Observability            | Sentry + PostHog wiring                                         |
| Deploy targets           | Vercel for web; Railway/Fly for APIs and workers                |
| Provider spike           | Confirm live model ids, per-image pricing, rate limits (PRD Q4) |
