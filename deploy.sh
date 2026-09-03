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

echo "==> Installing / reloading nginx config..."
# One file per subdomain (content-api/geo-api/web all share this box but
# route by server_name, not by path) — mirrors the box's actual Certbot
# layout, not a made-up single-domain topology. content-api.conf carries the
# proxy_read_timeout 180s that keeps the ~120s Instagram Reel transcoding
# poll from getting cut short by nginx's 60s default.
for site in content-api geo-api web; do
  sudo cp "nginx/${site}.conf" "/etc/nginx/sites-available/${site}.conf"
done
sudo nginx -t && sudo systemctl reload nginx

echo "==> Restarting all services..."
pm2 restart all

sleep 3
echo "==> Done. Current status:"
pm2 list
