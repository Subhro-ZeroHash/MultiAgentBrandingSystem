#!/usr/bin/env node
/**
 * Starts the Cloudflare quick tunnel and writes its URL into `.env`.
 *
 * The free trycloudflare URL is regenerated on every restart, and two env
 * vars have to match it exactly: `PUBLIC_ASSET_BASE_URL` (Meta downloads the
 * image from this origin when publishing) and `INSTAGRAM_OAUTH_REDIRECT_URI`.
 * Updating them by hand is the step that gets forgotten, and the failure
 * surfaces much later as a "Posting Failed" dialog blaming the image rather
 * than the stale tunnel — see `assertImageUrlReachable` in
 * apps/content-api/src/social/social.service.ts, which exists to explain
 * exactly this.
 *
 * So this replaces `cloudflared tunnel --url ...` directly: it starts the
 * tunnel, waits for the URL cloudflared prints, rewrites both vars in place,
 * and then stays in the foreground as a normal tunnel process (Ctrl-C stops
 * it). `.env` keeps every other line and its ordering untouched.
 *
 * Servers read env at boot, so anything already running still holds the old
 * value — restart content-api after this prints the new URL.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const PORT = process.env.WEB_PORT ?? '3000';

/** Both vars point at the same origin; only the OAuth one carries a path. */
const VARS = {
  PUBLIC_ASSET_BASE_URL: (origin) => origin,
  INSTAGRAM_OAUTH_REDIRECT_URI: (origin) => `${origin}/callback`,
};

function applyToEnvFile(origin) {
  const original = readFileSync(ENV_PATH, 'utf8');
  let updated = original;

  for (const [name, buildValue] of Object.entries(VARS)) {
    const value = buildValue(origin);
    // Anchored per line so a var never matches another that merely shares its
    // prefix, and so commented-out examples above it are left alone.
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    updated = pattern.test(updated)
      ? updated.replace(pattern, `${name}=${value}`)
      : `${updated.endsWith('\n') ? updated : `${updated}\n`}${name}=${value}\n`;
  }

  if (updated === original) return false;
  writeFileSync(ENV_PATH, updated);
  return true;
}

const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: ['ignore', 'inherit', 'pipe'],
});

let claimed = false;

// cloudflared logs the URL to stderr, inside a boxed banner.
child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);

  if (claimed) return;
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match) return;

  claimed = true;
  const origin = match[0];
  const changed = applyToEnvFile(origin);
  console.warn(
    `\n[tunnel] ${changed ? 'updated' : 'already current in'} .env → ${origin}\n` +
      '[tunnel] restart content-api so it picks the new value up: pnpm --filter @bmas/content-api dev\n',
  );
});

child.on('exit', (code) => process.exit(code ?? 0));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
