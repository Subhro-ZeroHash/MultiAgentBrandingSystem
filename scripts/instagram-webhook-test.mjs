#!/usr/bin/env node
/**
 * Plays Meta against the local Instagram webhook, since Meta can't reach
 * localhost: runs the verify-token handshake, then sends one signed comment or
 * DM delivery to content-api, exactly as Meta would.
 *
 *   pnpm webhook:test                       a comment with sample text
 *   pnpm webhook:test dm "Is size 7 available?"
 *
 * Needs content-api running locally and INSTAGRAM_APP_SECRET +
 * INSTAGRAM_WEBHOOK_VERIFY_TOKEN in `.env`. Every run uses fresh ids, so each
 * one is stored as a new event; the signature is the real HMAC check.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, '')];
    }),
);
const URL_ = `http://localhost:${env.CONTENT_API_PORT || '4000'}/api/webhooks/instagram`;
const [kind = 'comment', text = 'Hi! Is this available in size 7? Price?'] = process.argv.slice(2);

if (!env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
  console.error('Set INSTAGRAM_APP_SECRET and INSTAGRAM_WEBHOOK_VERIFY_TOKEN in .env first.');
  process.exit(1);
}

const handshake = await fetch(
  `${URL_}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN)}&hub.challenge=42`,
);
console.log(
  `handshake      ${handshake.status} ${handshake.ok ? '(Meta would accept this URL)' : await handshake.text()}`,
);

const account = 'local-test-account';
const id = randomUUID().slice(0, 8);
const entry =
  kind === 'dm'
    ? {
        id: account,
        time: Date.now(),
        messaging: [
          {
            sender: { id: 'local-customer' },
            recipient: { id: account },
            timestamp: Date.now(),
            message: { mid: `local-mid-${id}`, text },
          },
        ],
      }
    : {
        id: account,
        time: Date.now(),
        changes: [
          {
            field: 'comments',
            value: {
              id: `local-comment-${id}`,
              text,
              from: { id: 'local-customer', username: 'local.customer' },
              media: { id: 'local-media' },
            },
          },
        ],
      };
const body = JSON.stringify({ object: 'instagram', entry: [entry] });
const signature = `sha256=${createHmac('sha256', env.INSTAGRAM_APP_SECRET).update(body).digest('hex')}`;

const delivery = await fetch(URL_, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
  body,
});
console.log(`signed ${kind.padEnd(7)} ${delivery.status} ${await delivery.text()}`);

const forged = await fetch(URL_, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}`,
  },
  body,
});
console.log(
  `forged         ${forged.status} ${forged.status === 403 ? '(rejected, as it should be)' : '(SHOULD HAVE BEEN REJECTED)'}`,
);
