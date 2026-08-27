import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { QUEUES } from '@bmas/shared';
import type { Queue } from 'bullmq';
import { SocialService } from './social.service.js';
import { INSTAGRAM_INSIGHTS_SYNC_QUEUE } from '../core/core.module.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';

@Controller('social')
export class SocialController {
  constructor(
    private readonly social: SocialService,
    @Inject(INSTAGRAM_INSIGHTS_SYNC_QUEUE) private readonly insightsSyncQueue: Queue,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('auth/instagram/url')
  getInstagramAuthUrl(@Request() req: AuthenticatedRequest) {
    // `state` is issued here, not accepted from the caller: it has to identify
    // the request that started the login for the callback to trust it.
    return this.social.getOAuthUrl(req.user.id);
  }

  // Deliberately unguarded: Instagram redirects the user's browser here
  // directly, with no Authorization header to attach. See the comment below
  // on why the account owner is safe to trust from the state token alone.
  @Post('auth/instagram/callback')
  async handleInstagramCallback(@Body() body: { code?: string; state?: string }) {
    if (!body.code || !body.state) {
      throw new BadRequestException('code and state are required');
    }
    // The owner comes from the redeemed state, not the request: this call
    // arrives from a browser redirected by Instagram, carrying no identity.
    const account = await this.social.exchangeCodeForToken(body.code, body.state);
    return {
      id: account.id,
      displayName: account.displayName,
      platform: account.platform,
      status: account.status,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('accounts')
  async getUserAccounts(@Request() req: AuthenticatedRequest) {
    const resolvedUserId = req.user.id;
    const accounts = await this.social.getUserAccounts(resolvedUserId);
    return accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      displayName: a.displayName,
      status: a.status,
      connectedAt: a.connectedAt,
    }));
  }

  /** Live account stats and recent posts for one connected account. Read
   *  straight from Instagram rather than from `post_insights`, which only
   *  covers posts this app itself published — see SocialService. */
  @UseGuards(JwtAuthGuard)
  @Get('accounts/:id/insights')
  async getAccountInsights(@Param('id') accountId: string, @Request() req: AuthenticatedRequest) {
    return this.social.getAccountInsights(accountId, req.user.id);
  }

  /** Aggregated performance from the sync's stored history — the trend and
   *  community-response view, as opposed to `/insights`' live snapshot. */
  @UseGuards(JwtAuthGuard)
  @Get('accounts/:id/performance')
  async getAccountPerformance(
    @Param('id') accountId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.social.getAccountPerformance(accountId, req.user.id);
  }

  /**
   * Runs the insights sync now instead of waiting for the 6-hourly tick.
   *
   * Enqueues rather than syncing inline: the sweep is content-worker's job
   * and can take a while across many posts, so this returns as soon as the
   * work is queued — same producer/consumer split the rest of the app uses.
   */
  @UseGuards(JwtAuthGuard)
  @Post('accounts/:id/sync')
  async syncAccount(@Param('id') accountId: string, @Request() req: AuthenticatedRequest) {
    // Ownership is checked here so an unauthorised caller cannot queue work
    // against someone else's account.
    await this.social.getAccount(accountId, req.user.id);
    await this.insightsSyncQueue.add(
      QUEUES.instagramInsightsSync,
      {},
      { removeOnComplete: 20, removeOnFail: 50 },
    );
    return { queued: true };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('accounts/:id')
  async disconnectAccount(@Param('id') accountId: string, @Request() req: AuthenticatedRequest) {
    const resolvedUserId = req.user.id;
    await this.social.disconnectAccount(accountId, resolvedUserId);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('post')
  async postToInstagram(
    @Body() body: { accountId: string; assetId?: string; imageUrl?: string; caption: string },
    @Request() req: AuthenticatedRequest,
  ) {
    if (!body.accountId || !body.caption) {
      throw new BadRequestException('accountId and caption are required');
    }
    if (!body.assetId && !body.imageUrl) {
      throw new BadRequestException('assetId (preferred) or imageUrl is required');
    }
    const resolvedUserId = req.user.id;
    return this.social.postToInstagram(
      body.accountId,
      resolvedUserId,
      // An asset id lets the server build a URL Meta can reach; a raw imageUrl
      // has to already be public.
      {
        ...(body.assetId ? { assetId: body.assetId } : {}),
        ...(body.imageUrl ? { imageUrl: body.imageUrl } : {}),
      },
      body.caption,
    );
  }

  /** Video's counterpart of `postToInstagram` — same shape, `videoUrl` in
   *  place of `imageUrl`. */
  @UseGuards(JwtAuthGuard)
  @Post('post-reel')
  async postReelToInstagram(
    @Body() body: { accountId: string; assetId?: string; videoUrl?: string; caption: string },
    @Request() req: AuthenticatedRequest,
  ) {
    if (!body.accountId || !body.caption) {
      throw new BadRequestException('accountId and caption are required');
    }
    if (!body.assetId && !body.videoUrl) {
      throw new BadRequestException('assetId (preferred) or videoUrl is required');
    }
    return this.social.postReelToInstagram(
      body.accountId,
      req.user.id,
      {
        ...(body.assetId ? { assetId: body.assetId } : {}),
        ...(body.videoUrl ? { videoUrl: body.videoUrl } : {}),
      },
      body.caption,
    );
  }
}
