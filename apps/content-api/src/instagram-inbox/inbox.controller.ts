import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, schema, type Database } from '@bmas/db';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { DATABASE } from '../core/core.module.js';

// ponytail: the 100 most recent conversations; add paging when a brand has more.
const THREADS_LISTED = 100;

/** The Instagram Inbox, read-only: conversations content-worker collected
 *  (see instagram-inbox-sync.ts), each with its messages. */
@UseGuards(JwtAuthGuard)
@Controller('inbox/threads')
export class InboxController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
    const [row] = await this.db
      .select({ thread: schema.inboxThreads })
      .from(schema.inboxThreads)
      .innerJoin(schema.brands, eq(schema.brands.id, schema.inboxThreads.brandId))
      .where(and(eq(schema.inboxThreads.id, id), eq(schema.brands.ownerId, req.user.id)))
      .limit(1);
    if (!row) throw new NotFoundException('Conversation not found');

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
    return { ...row.thread, messages };
  }
}
