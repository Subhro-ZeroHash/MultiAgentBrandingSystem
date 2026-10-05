import { describeError } from '@bmas/ai';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  schema,
  sql,
  type Database,
  type SocialAccount,
} from '@bmas/db';
import { isTokenExpired, QUEUES, TokenEncryption } from '@bmas/shared';
import type { Queue } from 'bullmq';
import type { WorkerContext } from '../context.js';
import {
  fetchAccountMedia,
  graphGet,
  toDate,
  toText,
  type MediaSummary,
} from './instagram-insights-sync.js';

/**
 * Instagram Inbox intake: turns comments and DMs into inbox threads.
 *
 * Two sources feed the same tables. Webhook events (stored by content-api's
 * webhook route) are drained every tick, and every POLL_INTERVAL_MS each
 * enabled account is read directly — the only source while the Meta app is
 * unpublished (Meta sends no webhooks until then), and the catch-up for
 * anything missed while the box was down. Both produce `InboxItem`s, and a
 * message is stored once, whichever source sees it first.
 *
 * Only brands that turned the inbox on are read (`inbox_settings`), as the
 * privacy policy promises. Read-only towards Instagram.
 */

const TICK_MS = 60_000;
const POLL_INTERVAL_MS = 5 * 60_000;
/** Enabling the inbox brings in the last week, not years of history. */
const LOOKBACK_MS = 7 * 24 * 3_600_000;
// ponytail: only the newest posts are polled for comments; comments on older
// posts arrive by webhook once Meta grants Advanced Access.
const POSTS_POLLED = 10;
const CONVERSATIONS_POLLED = 20;
/** Instagram returns details only for a conversation's 20 newest messages. */
const MESSAGES_PER_CONVERSATION = 20;
const WEBHOOK_BATCH = 200;
/** Instagram lets a business answer a DM only this long after the customer's last message. */
const DM_WINDOW_MS = 24 * 3_600_000;
/** Drafts queued per tick; the rest follow on later ticks. */
const DRAFTS_PER_TICK = 10;

export interface InboxItem {
  channel: 'comment' | 'dm';
  /** Top-level comment id, or the customer's id for a DM. */
  threadKey: string;
  igMediaId: string | null;
  customerUsername: string | null;
  messageId: string;
  /** Written by the brand — here, or in the Instagram app itself. */
  fromBrand: boolean;
  username: string | null;
  text: string | null;
  sentAt: Date;
}

/** The connected account, so its own comments and messages can be told apart. */
export interface OwnAccount {
  id: string;
  username: string | null;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asRecords = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const dataOf = (value: unknown): Json[] => asRecords(isRecord(value) ? value.data : undefined);

/** Conversation times come as unix seconds or ISO text, depending on the endpoint. */
function toTime(value: unknown): Date | null {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    return new Date(Number(value) * 1000);
  }
  return toDate(value);
}

const commentUsername = (comment: Json): string | null =>
  toText(comment.username) ?? (isRecord(comment.from) ? toText(comment.from.username) : null);

function isOwn(from: unknown, username: string | null, own: OwnAccount): boolean {
  const id = isRecord(from) ? from.id : undefined;
  return id === own.id || (own.username !== null && username === own.username);
}

/** One post's comments, fetched with their `replies`. A top-level comment the
 *  brand wrote on its own post is not a conversation and is skipped. */
export function itemsFromComments(
  igMediaId: string,
  comments: Json[],
  own: OwnAccount,
): InboxItem[] {
  const items: InboxItem[] = [];
  for (const comment of comments) {
    const sentAt = toDate(comment.timestamp);
    const username = commentUsername(comment);
    if (typeof comment.id !== 'string' || !sentAt || isOwn(comment.from, username, own)) continue;

    const thread = {
      channel: 'comment' as const,
      threadKey: comment.id,
      igMediaId,
      customerUsername: username,
    };
    items.push({
      ...thread,
      messageId: comment.id,
      fromBrand: false,
      username,
      text: toText(comment.text),
      sentAt,
    });

    for (const reply of dataOf(comment.replies)) {
      const replySentAt = toDate(reply.timestamp);
      if (typeof reply.id !== 'string' || !replySentAt) continue;
      const replyUsername = commentUsername(reply);
      items.push({
        ...thread,
        messageId: reply.id,
        fromBrand: isOwn(reply.from, replyUsername, own),
        username: replyUsername,
        text: toText(reply.text),
        sentAt: replySentAt,
      });
    }
  }
  return items;
}

/** One DM, as read from a conversation (`id,created_time,from,to,message`). */
export function itemFromDm(message: Json, own: OwnAccount): InboxItem | null {
  const sentAt = toDate(message.created_time);
  const from = isRecord(message.from) ? message.from : null;
  if (typeof message.id !== 'string' || !sentAt || !from) return null;

  const fromBrand = isOwn(from, toText(from.username), own);
  const customer = fromBrand ? dataOf(message.to)[0] : from;
  const customerId = customer ? toText(customer.id) : null;
  if (!customer || !customerId) return null;

  return {
    channel: 'dm',
    threadKey: customerId,
    igMediaId: null,
    customerUsername: toText(customer.username),
    messageId: message.id,
    fromBrand,
    username: toText(from.username),
    // An empty message is a photo, sticker or share.
    text: toText(message.message) || null,
    sentAt,
  };
}

/** One stored webhook event (see `eventsFromDelivery` in content-api). Comment
 *  webhooks carry no timestamp, so the time Meta delivered one stands in. */
export function itemFromWebhookEvent(
  event: { field: string; payload: Json; receivedAt: Date },
  own: OwnAccount,
): InboxItem | null {
  const { payload } = event;

  if (event.field === 'comments') {
    if (typeof payload.id !== 'string') return null;
    const username = commentUsername(payload);
    const fromBrand = isOwn(payload.from, username, own);
    const parentId = toText(payload.parent_id);
    if (fromBrand && !parentId) return null;
    return {
      channel: 'comment',
      threadKey: parentId ?? payload.id,
      igMediaId: isRecord(payload.media) ? toText(payload.media.id) : null,
      customerUsername: fromBrand ? null : username,
      messageId: payload.id,
      fromBrand,
      username,
      text: toText(payload.text),
      sentAt: event.receivedAt,
    };
  }

  if (event.field === 'messages') {
    const message = isRecord(payload.message) ? payload.message : null;
    const mid = message ? toText(message.mid) : null;
    if (!message || !mid || message.is_deleted === true) return null;
    const senderId = isRecord(payload.sender) ? toText(payload.sender.id) : null;
    const recipientId = isRecord(payload.recipient) ? toText(payload.recipient.id) : null;
    const fromBrand = message.is_echo === true || senderId === own.id;
    const customerId = fromBrand ? recipientId : senderId;
    if (!customerId) return null;
    return {
      channel: 'dm',
      threadKey: customerId,
      igMediaId: null,
      // A DM webhook names only ids; the next poll fills the username in.
      customerUsername: null,
      messageId: mid,
      fromBrand,
      username: null,
      text: toText(message.text) || null,
      sentAt:
        typeof payload.timestamp === 'number' ? new Date(payload.timestamp) : event.receivedAt,
    };
  }

  // Reactions, read receipts, edits, Live comments: not conversations.
  return null;
}

type Target = Awaited<ReturnType<typeof getTargets>>[number];

const ownAccount = (account: SocialAccount): OwnAccount => ({
  id: account.igBusinessId ?? '',
  username: account.displayName.startsWith('@') ? account.displayName.slice(1) : null,
});

/** Ids this account's inbox already holds, so re-reading the same comments
 *  every five minutes costs one query rather than one per comment. */
async function knownMessageIds(
  db: Database,
  socialAccountId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.inboxMessages.igMessageId })
    .from(schema.inboxMessages)
    .innerJoin(schema.inboxThreads, eq(schema.inboxThreads.id, schema.inboxMessages.threadId))
    .where(
      and(
        eq(schema.inboxThreads.socialAccountId, socialAccountId),
        inArray(schema.inboxMessages.igMessageId, ids),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * Stores new items and keeps each thread's status in step with its newest
 * message: the customer's means it needs a reply, the brand's means it's
 * answered. An ignored thread comes back when the customer writes again.
 * Returns how many messages were new.
 */
async function ingestItems(
  db: Database,
  target: { brandId: string; socialAccountId: string },
  items: InboxItem[],
): Promise<number> {
  const now = new Date();
  const known = await knownMessageIds(
    db,
    target.socialAccountId,
    items.map((item) => item.messageId),
  );
  const fresh = items
    .filter(
      (item) => !known.has(item.messageId) && item.sentAt.getTime() >= now.getTime() - LOOKBACK_MS,
    )
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  let stored = 0;
  for (const item of fresh) {
    const [thread] = await db
      .insert(schema.inboxThreads)
      .values({
        brandId: target.brandId,
        socialAccountId: target.socialAccountId,
        channel: item.channel,
        externalId: item.threadKey,
        igMediaId: item.igMediaId,
        customerUsername: item.customerUsername,
        status: item.fromBrand ? 'replied' : 'needs_reply',
        lastMessageAt: item.sentAt,
        lastCustomerMessageAt: item.fromBrand ? null : item.sentAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.inboxThreads.socialAccountId,
          schema.inboxThreads.channel,
          schema.inboxThreads.externalId,
        ],
        set: {
          customerUsername: sql`coalesce(${schema.inboxThreads.customerUsername}, excluded.customer_username)`,
        },
      })
      .returning();
    if (!thread) continue;

    const [message] = await db
      .insert(schema.inboxMessages)
      .values({
        threadId: thread.id,
        igMessageId: item.messageId,
        direction: item.fromBrand ? 'out' : 'in',
        username: item.username,
        text: item.text,
        sentAt: item.sentAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.inboxMessages.id });
    if (!message) continue;
    stored++;

    const newest = item.sentAt >= thread.lastMessageAt;
    if (!newest && item.fromBrand) continue;
    await db
      .update(schema.inboxThreads)
      .set({
        ...(newest
          ? { status: item.fromBrand ? 'replied' : 'needs_reply', lastMessageAt: item.sentAt }
          : {}),
        ...(item.fromBrand
          ? {}
          : {
              lastCustomerMessageAt: sql`greatest(${schema.inboxThreads.lastCustomerMessageAt}, ${item.sentAt.toISOString()}::timestamptz)`,
              // Any new customer message, even one written earlier that the
              // poll only now saw, makes the current draft out of date.
              draftRequestedAt: now,
            }),
        updatedAt: now,
      })
      .where(eq(schema.inboxThreads.id, thread.id));
  }
  return stored;
}

/**
 * Comments actually received at the last successful poll, per account and
 * post. A post whose `comments_count` matches isn't re-read: Instagram limits
 * calls per account, and publishing draws on the same allowance. Counted from
 * what came back, not from `comments_count`: until App Review, Instagram
 * counts comments from accounts without a role on the app but doesn't return
 * them, and those posts must keep being read so the comments appear once it does.
 */
// ponytail: in memory, so a restart re-reads every post once; a deletion and a
// new comment in the same five minutes leave the count equal and are missed
// until webhooks are live.
const commentCountsSeen = new Map<string, number>();

async function pollComments(token: string, own: OwnAccount, socialAccountId: string) {
  const media = (await fetchAccountMedia(token)).slice(0, POSTS_POLLED);
  const items: InboxItem[] = [];
  const read: { post: MediaSummary; received: number }[] = [];
  for (const post of media) {
    const key = `${socialAccountId}:${post.id}`;
    if (post.commentsCount === 0) continue;
    if (post.commentsCount !== null && commentCountsSeen.get(key) === post.commentsCount) continue;

    const result = await graphGet(`${post.id}/comments`, {
      fields: 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}',
      limit: '50',
      access_token: token,
    });
    // Skipped, not fatal: one post Instagram won't return comments for must not
    // stop the others. Left unrecorded, so the next poll tries it again.
    if (!result.ok) {
      console.error(
        `[instagram-inbox] could not read comments on post ${post.id} — ${result.message}`,
      );
      continue;
    }
    const comments = dataOf(result.body);
    items.push(...itemsFromComments(post.id, comments, own));
    read.push({
      post,
      received: comments.reduce((n, comment) => n + 1 + dataOf(comment.replies).length, 0),
    });
  }
  return { items, read };
}

/**
 * When each account's DMs were last read in full. The next read looks back a
 * little before it; a read that failed or skipped a message doesn't count, so
 * the gap is read again rather than lost.
 */
// ponytail: in memory, so a restart re-reads the whole lookback window once.
const dmsReadAt = new Map<string, number>();

/** DMs from conversations active since `since`. Messages already stored are
 *  not re-read: each one costs its own Graph call. One that can't be read is
 *  skipped and the read reported incomplete, so the next poll tries it again. */
async function pollDms(
  db: Database,
  account: SocialAccount,
  token: string,
  own: OwnAccount,
  since: Date,
) {
  const list = await graphGet('me/conversations', {
    platform: 'instagram',
    fields: 'id,updated_time',
    limit: String(CONVERSATIONS_POLLED),
    access_token: token,
  });
  if (!list.ok) throw new Error(`could not list conversations — ${list.message}`);

  const items: InboxItem[] = [];
  let complete = true;
  const skip = (what: string, message: string) => {
    complete = false;
    console.error(`[instagram-inbox] ${account.displayName}: could not read ${what} — ${message}`);
  };
  for (const conversation of dataOf(list.body)) {
    const updated = toTime(conversation.updated_time);
    if (typeof conversation.id !== 'string' || (updated && updated < since)) continue;

    const detail = await graphGet(conversation.id, { fields: 'messages', access_token: token });
    if (!detail.ok) {
      skip('a conversation', detail.message);
      continue;
    }
    const recent = dataOf(detail.body.messages)
      .slice(0, MESSAGES_PER_CONVERSATION)
      .filter((m) => typeof m.id === 'string' && (toTime(m.created_time) ?? since) >= since)
      .map((m) => m.id as string);

    const known = await knownMessageIds(db, account.id, recent);
    for (const id of recent.filter((messageId) => !known.has(messageId))) {
      const message = await graphGet(id, {
        fields: 'id,created_time,from,to,message',
        access_token: token,
      });
      if (!message.ok) {
        skip('a message', message.message);
        continue;
      }
      const item = itemFromDm(message.body, own);
      if (item) items.push(item);
    }
  }
  return { items, complete };
}

async function pollAccount(
  ctx: WorkerContext,
  encryption: TokenEncryption,
  target: Target,
): Promise<void> {
  const { account } = target;
  const now = new Date();
  // Stamped first, so a failing account is retried next interval, not every tick.
  await ctx.db
    .update(schema.inboxSettings)
    .set({ lastPolledAt: now })
    .where(eq(schema.inboxSettings.id, target.settings.id));
  // Same as the insights sync and publishing: an expired token shows as
  // "reconnect" in Settings rather than the inbox quietly reading nothing.
  if (isTokenExpired(account.tokenExpiresAt)) {
    await ctx.db
      .update(schema.socialAccounts)
      .set({ status: 'token_expired' as const })
      .where(eq(schema.socialAccounts.id, account.id));
    console.warn(`[instagram-inbox] ${account.displayName}: token expired, marked for reconnect`);
    return;
  }

  const token = encryption.decrypt(account.pageAccessToken);
  const own = ownAccount(account);
  // Overlaps the last full read a little, so a message landing mid-read isn't skipped.
  const dmSince = new Date(
    Math.max(now.getTime() - LOOKBACK_MS, (dmsReadAt.get(account.id) ?? 0) - 10 * 60_000),
  );

  const [comments, dms] = await Promise.allSettled([
    pollComments(token, own, account.id),
    pollDms(ctx.db, account, token, own, dmSince),
  ]);
  for (const [what, result] of [
    ['comments', comments],
    ['DMs', dms],
  ] as const) {
    if (result.status === 'rejected') {
      console.error(
        `[instagram-inbox] ${account.displayName}: ${what} ${describeError(result.reason)}`,
      );
    }
  }

  const stored = await ingestItems(ctx.db, target.settings, [
    ...(comments.status === 'fulfilled' ? comments.value.items : []),
    ...(dms.status === 'fulfilled' ? dms.value.items : []),
  ]);
  if (dms.status === 'fulfilled' && dms.value.complete) dmsReadAt.set(account.id, now.getTime());
  for (const { post, received } of comments.status === 'fulfilled' ? comments.value.read : []) {
    // Recorded only once the comments are stored, so a failed store re-reads them.
    commentCountsSeen.set(`${account.id}:${post.id}`, received);
    // Webhooks don't name the post's caption, so threads get it from here.
    await ctx.db
      .update(schema.inboxThreads)
      .set({ postCaption: post.caption, postPermalink: post.permalink })
      .where(
        and(
          eq(schema.inboxThreads.socialAccountId, account.id),
          eq(schema.inboxThreads.igMediaId, post.id),
        ),
      );
  }
  if (stored > 0)
    console.warn(`[instagram-inbox] ${account.displayName}: ${stored} new message(s)`);
}

/** Webhook events not yet turned into inbox messages. Events for an account
 *  with no enabled inbox are marked done unread. */
async function drainWebhookEvents(db: Database, targets: Target[]): Promise<void> {
  const events = await db
    .select()
    .from(schema.instagramWebhookEvents)
    .where(isNull(schema.instagramWebhookEvents.processedAt))
    .orderBy(asc(schema.instagramWebhookEvents.receivedAt))
    .limit(WEBHOOK_BATCH);

  for (const event of events) {
    let error: string | null = null;
    try {
      for (const target of targets) {
        if (target.account.igBusinessId !== event.igAccountId) continue;
        const item = itemFromWebhookEvent(event, ownAccount(target.account));
        if (item) await ingestItems(db, target.settings, [item]);
      }
    } catch (failure) {
      error = describeError(failure);
      console.error(`[instagram-inbox] webhook event ${event.id}: ${error}`);
    }
    await db
      .update(schema.instagramWebhookEvents)
      .set({ processedAt: new Date(), error })
      .where(eq(schema.instagramWebhookEvents.id, event.id));
  }
}

function getTargets(db: Database) {
  return db
    .select({ settings: schema.inboxSettings, account: schema.socialAccounts })
    .from(schema.inboxSettings)
    .innerJoin(
      schema.socialAccounts,
      eq(schema.socialAccounts.id, schema.inboxSettings.socialAccountId),
    )
    .where(
      and(
        eq(schema.inboxSettings.enabled, true),
        eq(schema.socialAccounts.platform, 'instagram'),
        eq(schema.socialAccounts.status, 'active'),
        isNotNull(schema.socialAccounts.igBusinessId),
      ),
    );
}

/**
 * Conversations whose latest customer message has no draft yet, newest
 * first. The job id carries when that message arrived, so later ticks don't
 * queue the same draft twice. DMs past Instagram's 24-hour reply window are
 * left out: no reply can be sent, so a draft would be paid for and unused.
 */
async function queueDrafts(db: Database, draftQueue: Queue): Promise<void> {
  const due = await db
    .select({
      id: schema.inboxThreads.id,
      draftRequestedAt: schema.inboxThreads.draftRequestedAt,
      createdAt: schema.inboxThreads.createdAt,
    })
    .from(schema.inboxThreads)
    .innerJoin(
      schema.inboxSettings,
      and(
        eq(schema.inboxSettings.brandId, schema.inboxThreads.brandId),
        eq(schema.inboxSettings.enabled, true),
      ),
    )
    .where(
      and(
        eq(schema.inboxThreads.status, 'needs_reply'),
        // Threads from before drafts existed have no request time, only no draft.
        or(
          isNull(schema.inboxThreads.draftedAt),
          lt(schema.inboxThreads.draftedAt, schema.inboxThreads.draftRequestedAt),
        ),
        or(
          eq(schema.inboxThreads.channel, 'comment'),
          gte(schema.inboxThreads.lastCustomerMessageAt, new Date(Date.now() - DM_WINDOW_MS)),
        ),
      ),
    )
    .orderBy(desc(schema.inboxThreads.lastMessageAt))
    .limit(DRAFTS_PER_TICK);

  for (const { id, draftRequestedAt, createdAt } of due) {
    const requestedAt = draftRequestedAt ?? createdAt;
    await draftQueue.add(
      QUEUES.instagramInboxDraft,
      { threadId: id, requestedAt: requestedAt.toISOString() },
      {
        jobId: `draft-${id}-${requestedAt.getTime()}`,
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    );
  }
}

/** The tick: webhook events every minute, each account's own poll when due,
 *  then drafts for whatever needs a reply. One account failing is logged and
 *  the rest still run. */
export async function runInstagramInboxSync(ctx: WorkerContext, draftQueue: Queue): Promise<void> {
  const targets = await getTargets(ctx.db);
  await drainWebhookEvents(ctx.db, targets);

  const encryption = new TokenEncryption(ctx.encryptionKey);
  const dueBefore = Date.now() - POLL_INTERVAL_MS;
  for (const target of targets) {
    const { lastPolledAt } = target.settings;
    if (lastPolledAt && lastPolledAt.getTime() > dueBefore) continue;
    try {
      await pollAccount(ctx, encryption, target);
    } catch (error) {
      console.error(
        `[instagram-inbox] failed to poll ${target.account.displayName}: ${describeError(error)}`,
      );
    }
  }
  await queueDrafts(ctx.db, draftQueue);
}

/** Same idempotent repeatable-job registration as the insights sync tick. */
export async function scheduleInstagramInboxSyncTick(queue: Queue): Promise<void> {
  await queue.add(
    QUEUES.instagramInboxSync,
    {},
    {
      jobId: 'instagram-inbox-sync-tick',
      repeat: { every: TICK_MS },
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  );
}
