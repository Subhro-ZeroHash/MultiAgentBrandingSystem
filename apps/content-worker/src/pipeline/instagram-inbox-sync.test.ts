import { describe, expect, it } from 'vitest';
import { itemFromDm, itemFromWebhookEvent, itemsFromComments } from './instagram-inbox-sync.js';

/** The brand's own account, as `ownAccount` builds it from social_accounts. */
const own = { id: 'brand-ig', username: 'bata' };
const receivedAt = new Date('2026-10-05T10:00:00Z');

describe('itemsFromComments', () => {
  it('makes a thread per top-level comment and marks the brand’s replies', () => {
    const items = itemsFromComments(
      'media-1',
      [
        {
          id: 'c1',
          text: 'Size 8 milega?',
          timestamp: '2026-10-05T09:00:00+0000',
          username: 'priya',
          from: { id: 'cust-1', username: 'priya' },
          replies: {
            data: [
              {
                id: 'r1',
                text: 'Haan ji!',
                timestamp: '2026-10-05T09:05:00+0000',
                username: 'bata',
                from: { id: 'brand-ig', username: 'bata' },
              },
            ],
          },
        },
        // The brand's own comment on its post is not a conversation.
        {
          id: 'c2',
          text: 'Link in bio',
          timestamp: '2026-10-05T08:00:00+0000',
          from: { id: 'brand-ig' },
        },
      ],
      own,
    );

    expect(items.map((i) => [i.threadKey, i.messageId, i.fromBrand])).toEqual([
      ['c1', 'c1', false],
      ['c1', 'r1', true],
    ]);
    expect(items[0]).toMatchObject({
      channel: 'comment',
      igMediaId: 'media-1',
      customerUsername: 'priya',
    });
  });
});

describe('itemFromDm', () => {
  it('keys a DM thread on the customer, whichever side sent it', () => {
    const inbound = itemFromDm(
      {
        id: 'm1',
        created_time: '2026-10-05T09:00:00+0000',
        from: { id: 'cust-1', username: 'priya' },
        to: { data: [{ id: 'brand-ig' }] },
        message: 'Price?',
      },
      own,
    );
    const outbound = itemFromDm(
      {
        id: 'm2',
        created_time: '2026-10-05T09:01:00+0000',
        from: { id: 'brand-ig', username: 'bata' },
        to: { data: [{ id: 'cust-1', username: 'priya' }] },
        message: '',
      },
      own,
    );
    expect(inbound).toMatchObject({
      threadKey: 'cust-1',
      fromBrand: false,
      text: 'Price?',
      customerUsername: 'priya',
    });
    expect(outbound).toMatchObject({ threadKey: 'cust-1', fromBrand: true, text: null });
  });
});

describe('itemFromWebhookEvent', () => {
  it('threads a comment reply under its parent', () => {
    const item = itemFromWebhookEvent(
      {
        field: 'comments',
        receivedAt,
        payload: {
          id: 'r2',
          parent_id: 'c1',
          text: 'Thanks',
          from: { id: 'cust-1', username: 'priya' },
          media: { id: 'media-1' },
        },
      },
      own,
    );
    expect(item).toMatchObject({
      threadKey: 'c1',
      messageId: 'r2',
      igMediaId: 'media-1',
      fromBrand: false,
      sentAt: receivedAt,
    });
  });

  it('treats echoes as the brand’s own replies and skips deletes and reactions', () => {
    const echo = itemFromWebhookEvent(
      {
        field: 'messages',
        receivedAt,
        payload: {
          sender: { id: 'brand-ig' },
          recipient: { id: 'cust-1' },
          timestamp: 1_791_000_000_000,
          message: { mid: 'mid-1', text: 'Hi', is_echo: true },
        },
      },
      own,
    );
    expect(echo).toMatchObject({ threadKey: 'cust-1', fromBrand: true, messageId: 'mid-1' });
    expect(echo?.sentAt.getTime()).toBe(1_791_000_000_000);

    expect(
      itemFromWebhookEvent(
        {
          field: 'messages',
          receivedAt,
          payload: { sender: { id: 'cust-1' }, message: { mid: 'mid-2', is_deleted: true } },
        },
        own,
      ),
    ).toBeNull();
    expect(
      itemFromWebhookEvent(
        { field: 'message_reactions', receivedAt, payload: { reaction: {} } },
        own,
      ),
    ).toBeNull();
  });
});
