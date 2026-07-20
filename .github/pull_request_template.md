## What & why

<!-- One or two sentences. Link the issue if there is one. -->

## Workstream

- [ ] GEO
- [ ] Content generation
- [ ] Shared (`packages/*`, infra, CI)

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm build` passes locally
- [ ] Schema changes include a generated migration (`pnpm db:generate`)
- [ ] No provider SDK imported outside `packages/ai/src/adapters` (see [docs/architecture.md](../docs/architecture.md))
- [ ] New env vars added to `.env.example` with a comment
- [ ] Touches shared packages? Flagged the other workstream owner as a reviewer

## Notes for the reviewer

<!-- Anything non-obvious: trade-offs taken, things deliberately left out. -->
