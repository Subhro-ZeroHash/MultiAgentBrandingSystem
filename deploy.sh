#!/usr/bin/env bash
# Pulls the latest merged code, rebuilds, applies any new migrations, and
# restarts all 5 services. Safe to run any time — if a step fails, the script
# stops before restarting anything, so the currently-running services keep
# serving traffic on the old (working) build rather than getting killed into
# a broken state.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> Pulling latest code..."
git pull

echo "==> Installing dependencies..."
pnpm install

echo "==> Building (Turborepo skips anything unchanged, so this is fast)..."
pnpm build

echo "==> Applying any new database migrations..."
pnpm db:migrate

echo "==> Restarting all services..."
pm2 restart all

sleep 3
echo "==> Done. Current status:"
pm2 list
