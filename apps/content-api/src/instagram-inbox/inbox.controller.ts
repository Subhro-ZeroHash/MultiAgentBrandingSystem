import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, schema, type Database } from '@bmas/db';
import {
  QUEUES,
  sendInboxReplySchema,
  type InstagramInboxDraftJob,
  type SendInboxReplyInput,
} from '@bmas/shared';
import type { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { PerUserRateLimitGuard } from '../common/per-user-rate-limit.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE, INSTAGRAM_INBOX_DRAFT_QUEUE } from '../core/core.module.js';
import { SocialService } from '../social/social.service.js';

// ponytail: the 100 most recent conversations; add paging when a brand has more.
const THREADS_LISTED = 100;
/** Instagram lets a business answer a DM only this long after the customer's last message. */
const DM_WINDOW_MS = 24 * 3_600_000;
/** Instagram's limit for a DM's text. */
const DM_MAX_BYTES = 1000;
/** Each Regenerate is a paid model call. */
const regenerateLimit = new PerUserRateLimitGuard(60, 3_600_000);

const windowClosed = (thread: { channel: string; lastCustomerMessageAt: Date | null }) =>
  thread.channel === 'dm' &&
  (thread.lastCustomerMessageAt?.getTime() ?? 0) < Date.now() - DM_WINDOW_MS;

/** The Instagram Inbox: conversations content-worker collected (see
 *  instagram-inbox-sync.ts), each with its messages and AI draft reply. */
@UseGuards(JwtAuthGuard)
@Controller('inbox/threads')
export class InboxController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INSTAGRAM_INBOX_DRAFT_QUEUE) private readonly draftQueue: Queue,
    private readonly social: SocialService,
  ) {}

  /** Conversations a reply is being sent for right now: a double click, a
   *  second tab, or auto-reply racing a person must not answer twice. */
  // ponytail: in-process, which is right for the single content-api process;
  // a Redis lock if the API ever runs as several.
  private readonly sending = new Set<string>();

  @Get()
  async list(@Query('brandId') brandId: string | undefined, @Request() req: AuthenticatedRequest) {
    if (!brandId) throw new BadRequestException('brandId query param is required');
    const [brand] = await this.db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.id, brandId), eq(schema.brands.ownerId, req.user.id)))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);

    const threads = await this.db
      .select()
      .from(schema.inboxThreads)
      .where(eq(schema.inboxThreads.brandId, brandId))
      .orderBy(desc(schema.inboxThreads.lastMessageAt))
      .limit(THREADS_LISTED);
    if (threads.length === 0) return [];

    // Each thread's newest message, for the list's preview line.
    const latest = await this.db
      .selectDistinctOn([schema.inboxMessages.threadId], {
        threadId: schema.inboxMessages.threadId,
        direction: schema.inboxMessages.direction,
        text: schema.inboxMessages.text,
      })
      .from(schema.inboxMessages)
      .where(
        inArray(
          schema.inboxMessages.threadId,
          threads.map((thread) => thread.id),
        ),
      )
      .orderBy(schema.inboxMessages.threadId, desc(schema.inboxMessages.sentAt));
    const byThread = new Map(latest.map(({ threadId, ...message }) => [threadId, message]));
    return threads.map((thread) => ({ ...thread, lastMessage: byThread.get(thread.id) ?? null }));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    const thread = await this.ownedThread(id, req.user.id);
    const messages = await this.db
      .select({
        id: schema.inboxMessages.id,
        direction: schema.inboxMessages.direction,
        username: schema.inboxMessages.username,
        text: schema.inboxMessages.text,
        sentAt: schema.inboxMessages.sentAt,
        auto: schema.inboxMessages.auto,
      })
      .from(schema.inboxMessages)
      .where(eq(schema.inboxMessages.threadId, id))
      .orderBy(asc(schema.inboxMessages.sentAt));
    return { ...thread, messages };
  }

  /** Regenerate: content-worker writes a fresh draft (inbox-draft.ts). */
  @Post(':id/draft')
  @HttpCode(202)
  @UseGuards(regenerateLimit)
  async regenerate(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    const thread = await this.ownedThread(id, req.user.id);
    if (thread.status !== 'needs_reply') {
      throw new BadRequestException('This conversation has already been answered.');
    }
    // The worker would skip both of these, leaving the page waiting on a draft.
    if (windowClosed(thread)) {
      throw new BadRequestException(
        "Instagram only allows a reply within 24 hours of the customer's last message.",
      );
    }
    const [enabled] = await this.db
      .select({ id: schema.inboxSettings.id })
      .from(schema.inboxSettings)
      .where(
        and(
          eq(schema.inboxSettings.brandId, thread.brandId),
          eq(schema.inboxSettings.enabled, true),
        ),
      )
      .limit(1);
    if (!enabled) throw new BadRequestException('Turn the Instagram Inbox on in Settings first.');
    const requestedAt = new Date().toISOString();
    const job: InstagramInboxDraftJob = { threadId: id, requestedAt, regenerate: true };
    await this.draftQueue.add(QUEUES.instagramInboxDraft, job, {
      jobId: `draft-${id}-r${Date.parse(requestedAt)}`,
      removeOnComplete: 500,
      removeOnFail: 500,
    });
    return { requestedAt };
  }

  /**
   * Sends the reply to Instagram: under the comment, or as a DM. Stored as the
   * brand's message with Instagram's own id, so the next poll recognises it,
   * and the conversation moves to Replied. Also what auto-reply calls, with a
   * short-lived token for the owner (content-worker, inbox-draft.ts).
   */
  @Post(':id/reply')
  async reply(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(sendInboxReplySchema)) body: unknown,
  ) {
    const input = body as SendInboxReplyInput;
    const thread = await this.ownedThread(id, req.user.id);
    if (thread.status !== 'needs_reply') {
      throw new BadRequestException('This conversation has already been answered.');
    }
    if (windowClosed(thread)) {
      throw new BadRequestException(
        "Instagram only allows a reply within 24 hours of the customer's last message.",
      );
    }
    if (thread.channel === 'dm' && Buffer.byteLength(input.text, 'utf8') > DM_MAX_BYTES) {
      throw new BadRequestException(
        'Instagram limits a DM to 1000 bytes — about 1000 letters in English, fewer in Hindi. Shorten it and try again.',
      );
    }
    if (this.sending.has(id)) throw new ConflictException('This reply is already being sent.');

    this.sending.add(id);
    try {
      const account = await this.social.getAccount(thread.socialAccountId, req.user.id);
      const igMessageId =
        thread.channel === 'comment'
          ? await this.social.replyToComment(account, thread.externalId, input.text)
          : await this.social.sendDirectMessage(account, thread.externalId, input.text);

      const sentAt = new Date();
      await this.db
        .insert(schema.inboxMessages)
        .values({
          threadId: id,
          igMessageId,
          direction: 'out',
          username: account.displayName.replace(/^@/, ''),
          text: input.text,
          sentAt,
          auto: input.auto ?? false,
        })
        .onConflictDoNothing();
      await this.db
        .update(schema.inboxThreads)
        .set({ status: 'replied', lastMessageAt: sentAt, updatedAt: sentAt })
        .where(eq(schema.inboxThreads.id, id));
      return { igMessageId, sentAt };
    } finally {
      this.sending.delete(id);
    }
  }

  /** Leaves a conversation without a reply. It comes back to Needs reply if
   *  the customer writes again. */
  @Post(':id/ignore')
  @HttpCode(204)
  async ignore(@Param('id') id: string, @Request() req: AuthenticatedRequest): Promise<void> {
    const thread = await this.ownedThread(id, req.user.id);
    if (thread.status !== 'needs_reply') return;
    await this.db
      .update(schema.inboxThreads)
      .set({ status: 'ignored', updatedAt: new Date() })
      .where(eq(schema.inboxThreads.id, id));
  }

  private async ownedThread(id: string, ownerId: string) {
    const [row] = await this.db
      .select({ thread: schema.inboxThreads })
      .from(schema.inboxThreads)
      .innerJoin(schema.brands, eq(schema.brands.id, schema.inboxThreads.brandId))
      .where(and(eq(schema.inboxThreads.id, id), eq(schema.brands.ownerId, ownerId)))
      .limit(1);
    if (!row) throw new NotFoundException('Conversation not found');
    return row.thread;
  }
}
