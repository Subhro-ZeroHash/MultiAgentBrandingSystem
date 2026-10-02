import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Pure helpers for Meta's Instagram webhooks, kept apart from the controller so
 * the security-relevant parts (handshake, signature) are unit-tested directly.
 */

/** Meta's subscription handshake: it calls the webhook URL with the verify
 *  token typed into the App Dashboard, and expects `hub.challenge` echoed back. */
export function isValidHandshake(
  mode: string | undefined,
  token: string | undefined,
  expected: string | undefined,
): boolean {
  if (mode !== 'subscribe' || !token || !expected) return false;
  const given = Buffer.from(token);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Every delivery is signed `sha256=<hex HMAC of the raw body>` with the
 *  Instagram app secret. Anything else — missing, malformed, or computed over a
 *  re-serialised body — is rejected. */
export function hasValidSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? '');
  if (!match?.[1]) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
}

export interface WebhookEvent {
  igAccountId: string;
  field: string;
  eventKey: string | null;
  payload: Record<string, unknown>;
}

/** Messaging items carry their kind as a key rather than a `field`; named here
 *  the way the dashboard's subscription fields are. */
const MESSAGING_KINDS: Record<string, string> = {
  message: 'messages',
  reaction: 'message_reactions',
  read: 'messaging_seen',
  postback: 'messaging_postbacks',
  referral: 'messaging_referral',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Flattens one delivery into one event per comment / message. Comments arrive
 * as `entry[].changes[]` (`field` + `value`), DMs as `entry[].messaging[]`.
 * The event key (comment id or message id) is what makes Meta's retries
 * harmless: the same comment delivered twice is stored once.
 */
export function eventsFromDelivery(body: unknown): WebhookEvent[] {
  if (!isRecord(body)) return [];
  const events: WebhookEvent[] = [];

  for (const entry of asArray(body.entry)) {
    if (!isRecord(entry) || entry.id === undefined || entry.id === null) continue;
    const igAccountId = String(entry.id);

    for (const change of asArray(entry.changes)) {
      if (!isRecord(change) || typeof change.field !== 'string' || !isRecord(change.value)) {
        continue;
      }
      const id = change.value.id;
      events.push({
        igAccountId,
        field: change.field,
        eventKey: typeof id === 'string' ? `${change.field}:${id}` : null,
        payload: change.value,
      });
    }

    for (const item of asArray(entry.messaging)) {
      if (!isRecord(item)) continue;
      const kind = Object.keys(MESSAGING_KINDS).find((key) => key in item);
      const field = kind ? MESSAGING_KINDS[kind]! : 'messaging';
      const mid = isRecord(item.message) ? item.message.mid : undefined;
      events.push({
        igAccountId,
        field,
        eventKey: field === 'messages' && typeof mid === 'string' ? `messages:${mid}` : null,
        payload: item,
      });
    }
  }
  return events;
}
