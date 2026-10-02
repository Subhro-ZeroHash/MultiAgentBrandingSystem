import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eventsFromDelivery, hasValidSignature, isValidHandshake } from './instagram-webhook.js';

const SECRET = 'test-app-secret';
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('isValidHandshake', () => {
  it('accepts only a subscribe request carrying the configured token', () => {
    expect(isValidHandshake('subscribe', 'tok-123', 'tok-123')).toBe(true);
    expect(isValidHandshake('subscribe', 'tok-124', 'tok-123')).toBe(false);
    expect(isValidHandshake('unsubscribe', 'tok-123', 'tok-123')).toBe(false);
    expect(isValidHandshake('subscribe', 'tok-123', undefined)).toBe(false);
    expect(isValidHandshake('subscribe', undefined, 'tok-123')).toBe(false);
  });
});

describe('hasValidSignature', () => {
  const body = '{"object":"instagram","entry":[]}';

  it('accepts the HMAC of the exact raw bytes', () => {
    expect(hasValidSignature(Buffer.from(body), sign(body), SECRET)).toBe(true);
  });

  it('rejects a wrong secret, a changed body, and malformed headers', () => {
    expect(hasValidSignature(Buffer.from(body), sign(body, 'other'), SECRET)).toBe(false);
    expect(hasValidSignature(Buffer.from(`${body} `), sign(body), SECRET)).toBe(false);
    expect(hasValidSignature(Buffer.from(body), undefined, SECRET)).toBe(false);
    expect(hasValidSignature(Buffer.from(body), 'sha256=abc', SECRET)).toBe(false);
    expect(
      hasValidSignature(Buffer.from(body), sign(body).replace('sha256=', 'sha1='), SECRET),
    ).toBe(false);
  });
});

describe('eventsFromDelivery', () => {
  it('splits comments and DMs into keyed events', () => {
    const events = eventsFromDelivery({
      object: 'instagram',
      entry: [
        {
          id: '1789',
          time: 1_700_000_000,
          changes: [
            {
              field: 'comments',
              value: { id: 'c1', text: 'Price?', from: { id: 'u1' }, media: { id: 'm1' } },
            },
          ],
          messaging: [
            {
              sender: { id: 'u2' },
              recipient: { id: '1789' },
              message: { mid: 'mid.1', text: 'Hi' },
            },
            { sender: { id: 'u2' }, recipient: { id: '1789' }, read: { mid: 'mid.0' } },
          ],
        },
      ],
    });
    expect(
      events.map(({ igAccountId, field, eventKey }) => ({ igAccountId, field, eventKey })),
    ).toEqual([
      { igAccountId: '1789', field: 'comments', eventKey: 'comments:c1' },
      { igAccountId: '1789', field: 'messages', eventKey: 'messages:mid.1' },
      { igAccountId: '1789', field: 'messaging_seen', eventKey: null },
    ]);
  });

  it('ignores shapes it does not recognise instead of throwing', () => {
    expect(eventsFromDelivery(null)).toEqual([]);
    expect(eventsFromDelivery({ entry: 'nope' })).toEqual([]);
    expect(eventsFromDelivery({ entry: [{ changes: [{ field: 'comments' }] }] })).toEqual([]);
  });
});
