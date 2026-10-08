import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { and, count, eq, ne, schema, sql, type Database } from '@bmas/db';
import {
  updateInboxSettingsSchema,
  type InboxSettings,
  type UpdateInboxSettingsInput,
} from '@bmas/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../core/core.module.js';

/**
 * A brand's Instagram Inbox switch. Off until the owner turns it on and
 * picks the account to read — content-worker's inbox sync reads nothing
 * for a brand without an enabled row here.
 */
@UseGuards(JwtAuthGuard)
@Controller('brands/:brandId/inbox-settings')
export class InboxSettingsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  async get(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
  ): Promise<InboxSettings> {
    await this.assertBrandOwned(brandId, req.user.id);
    return this.read(brandId);
  }

  @Put()
  async update(
    @Param('brandId') brandId: string,
    @Request() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(updateInboxSettingsSchema)) body: unknown,
  ): Promise<InboxSettings> {
    const input = body as UpdateInboxSettingsInput;
    await this.assertBrandOwned(brandId, req.user.id);
    const current = await this.read(brandId);

    if (!input.enabled) {
      await this.db
        .update(schema.inboxSettings)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(schema.inboxSettings.brandId, brandId));
      return this.read(brandId);
    }

    const socialAccountId = input.socialAccountId ?? current.socialAccountId;
    if (!socialAccountId) {
      throw new BadRequestException('Choose the Instagram account this inbox should read.');
    }
    const [account] = await this.db
      .select({ displayName: schema.socialAccounts.displayName })
      .from(schema.socialAccounts)
      .where(
        and(
          eq(schema.socialAccounts.id, socialAccountId),
          eq(schema.socialAccounts.ownerId, req.user.id),
          eq(schema.socialAccounts.platform, 'instagram'),
        ),
      )
      .limit(1);
    if (!account) throw new NotFoundException('Instagram account not found');

    // Checked here for a readable message; the unique index is the real guard.
    const [taken] = await this.db
      .select({ id: schema.inboxSettings.id })
      .from(schema.inboxSettings)
      .where(
        and(
          eq(schema.inboxSettings.socialAccountId, socialAccountId),
          ne(schema.inboxSettings.brandId, brandId),
        ),
      )
      .limit(1);
    if (taken) {
      throw new ConflictException(
        `${account.displayName} already feeds another brand's inbox. Turn that one off first.`,
      );
    }

    const autoReply = input.autoReply ?? current.autoReply;
    await this.db
      .insert(schema.inboxSettings)
      .values({ brandId, socialAccountId, enabled: true, autoReply })
      .onConflictDoUpdate({
        target: schema.inboxSettings.brandId,
        set: { socialAccountId, enabled: true, autoReply, updatedAt: new Date() },
      });
    return this.read(brandId);
  }

  private async read(brandId: string): Promise<InboxSettings> {
    const [row] = await this.db
      .select()
      .from(schema.inboxSettings)
      .where(eq(schema.inboxSettings.brandId, brandId))
      .limit(1);
    const [threads] = await this.db
      .select({
        total: count(),
        needsReply: count(sql`case when ${schema.inboxThreads.status} = 'needs_reply' then 1 end`),
      })
      .from(schema.inboxThreads)
      .where(eq(schema.inboxThreads.brandId, brandId));
    return {
      enabled: row?.enabled ?? false,
      autoReply: row?.autoReply ?? false,
      socialAccountId: row?.socialAccountId ?? null,
      lastPolledAt: row?.lastPolledAt?.toISOString() ?? null,
      conversations: threads?.total ?? 0,
      needsReply: threads?.needsReply ?? 0,
    };
  }

  private async assertBrandOwned(brandId: string, ownerId: string): Promise<void> {
    const [brand] = await this.db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.id, brandId), eq(schema.brands.ownerId, ownerId)))
      .limit(1);
    if (!brand) throw new NotFoundException(`Brand ${brandId} not found`);
  }
}
