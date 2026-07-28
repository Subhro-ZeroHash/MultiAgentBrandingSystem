import { Controller, Get, Post, Delete, Body, Param, Headers, BadRequestException } from '@nestjs/common';
import { SocialService } from './social.service.js';
import { getUserIdFromHeader } from '../common/user-id.js';

@Controller('social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('auth/instagram/url')
  getInstagramAuthUrl(@Headers('x-user-id') userId?: string) {
    // `state` is issued here, not accepted from the caller: it has to identify
    // the request that started the login for the callback to trust it.
    return this.social.getOAuthUrl(getUserIdFromHeader(userId));
  }

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

  @Get('accounts')
  async getUserAccounts(@Headers('x-user-id') userId?: string) {
    const resolvedUserId = getUserIdFromHeader(userId);
    const accounts = await this.social.getUserAccounts(resolvedUserId);
    return accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      displayName: a.displayName,
      status: a.status,
      connectedAt: a.connectedAt,
    }));
  }

  @Delete('accounts/:id')
  async disconnectAccount(
    @Param('id') accountId: string,
    @Headers('x-user-id') userId?: string,
  ) {
    const resolvedUserId = getUserIdFromHeader(userId);
    await this.social.disconnectAccount(accountId, resolvedUserId);
    return { success: true };
  }

  @Post('post')
  async postToInstagram(
    @Body() body: { accountId: string; assetId?: string; imageUrl?: string; caption: string },
    @Headers('x-user-id') userId?: string,
  ) {
    if (!body.accountId || !body.caption) {
      throw new BadRequestException('accountId and caption are required');
    }
    if (!body.assetId && !body.imageUrl) {
      throw new BadRequestException('assetId (preferred) or imageUrl is required');
    }
    const resolvedUserId = getUserIdFromHeader(userId);
    return this.social.postToInstagram(
      body.accountId,
      resolvedUserId,
      // An asset id lets the server build a URL Meta can reach; a raw imageUrl
      // has to already be public.
      { ...(body.assetId ? { assetId: body.assetId } : {}), ...(body.imageUrl ? { imageUrl: body.imageUrl } : {}) },
      body.caption,
    );
  }
}
