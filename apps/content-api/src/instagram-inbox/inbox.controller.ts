import {
  BadRequestException,
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
import { QUEUES, type InstagramInboxDraftJob } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { PerUserRateLimitGuard } from '../common/per-user-rate-limit.guard.js';
import { DATABASE, INSTAGRAM_INBOX_DRAFT_QUEUE } from '../core/core.module.js';

// ponytail: the 100 most recent conversations; add paging when a brand has more.
const THREADS_LISTED = 100;
/** Instagram lets a business answer a DM only this long after the customer's last message. */
const DM_WINDOW_MS = 24 * 3_600_000;
/** Each Regenerate is a paid model call. */
const regenerateLimit = new PerUserRateLimitGuard(60, 3_600_000);

/** The Instagram Inbox: conversations content-worker collected (see
 *  instagram-inbox-sync.ts), each with its messages and AI draft reply. */
@UseGuards(JwtAuthGuard)
@Controller('inbox/threads')
export class InboxController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INSTAGRAM_INBOX_DRAFT_QUEUE) private readonly draftQueue: Queue,
  ) {}

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
    if (
      thread.channel === 'dm' &&
      (thread.lastCustomerMessageAt?.getTime() ?? 0) < Date.now() - DM_WINDOW_MS
    ) {
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
    const job: InstagramInboxDraftJob = { threadId: id, requestedAt };
    await this.draftQueue.add(QUEUES.instagramInboxDraft, job, {
      jobId: `draft-${id}-r${Date.parse(requestedAt)}`,
      removeOnComplete: 500,
      removeOnFail: 500,
    });
    return { requestedAt };
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
