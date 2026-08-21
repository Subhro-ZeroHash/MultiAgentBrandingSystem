import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { SocialService } from './social.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';

@Controller('social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

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
}
