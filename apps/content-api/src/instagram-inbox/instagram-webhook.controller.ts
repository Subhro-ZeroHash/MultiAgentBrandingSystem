import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { schema, type Database } from '@bmas/db';
import { DATABASE } from '../core/core.module.js';
import { loadEnv } from '../config/env.js';
import { eventsFromDelivery, hasValidSignature, isValidHandshake } from './instagram-webhook.js';

/**
 * Meta's callback for Instagram comments and DMs:
 * `https://<api host>/api/webhooks/instagram`.
 *
 * Public on purpose (no JwtAuthGuard): Meta authenticates with the verify
 * token on the handshake and an HMAC signature on every delivery instead.
 * Not rate-limited, since Meta's retries come from a handful of IPs. It does
 * no work beyond storing the events — Meta expects a fast 200, and replies
 * are drafted by the worker from `instagram_webhook_events`.
 */
@SkipThrottle()
@Controller('webhooks/instagram')
export class InstagramWebhookController {
  private readonly logger = new Logger(InstagramWebhookController.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Header('Content-Type', 'text/plain')
  handshake(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    if (!challenge || !isValidHandshake(mode, token, loadEnv().INSTAGRAM_WEBHOOK_VERIFY_TOKEN)) {
      throw new ForbiddenException('Webhook verify token does not match.');
    }
    return challenge;
  }

  @Post()
  @HttpCode(200)
  async receive(
    // `rawBody` is kept by main.ts (`rawBody: true`): the signature covers the
    // exact bytes Meta sent, which re-serialising the parsed body won't match.
    @Req() req: { rawBody?: Buffer; body: unknown },
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<string> {
    const env = loadEnv();
    const rawBody = req.rawBody;
    const signedBy = [
      ['instagram', env.INSTAGRAM_APP_SECRET],
      ['meta', env.META_APP_SECRET],
    ].find(([, secret]) => secret && rawBody && hasValidSignature(rawBody, signature, secret))?.[0];
    if (!signedBy) throw new ForbiddenException('Invalid webhook signature.');

    const events = eventsFromDelivery(req.body);
    if (events.length > 0) {
      await this.db.insert(schema.instagramWebhookEvents).values(events).onConflictDoNothing();
    }
    // Counts only: the payloads are customers' messages.
    const counts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.field] = (acc[event.field] ?? 0) + 1;
      return acc;
    }, {});
    this.logger.log(
      `received ${events.length} event(s) ${JSON.stringify(counts)} for ${[
        ...new Set(events.map((event) => event.igAccountId)),
      ].join(', ')} (signed with the ${signedBy} app secret)`,
    );
    return 'EVENT_RECEIVED';
  }
}
