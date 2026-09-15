import { Controller, Get, Query, Request, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/authenticated-request.js';
import { GoogleAuthService } from './google-auth.service.js';

function landingPage(title: string, message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;text-align:center;padding:0 24px;color:#1a1a1a}</style></head>
<body><div><h2>${title}</h2><p>${message}</p></div></body></html>`;
}

@Controller('google')
export class GoogleAuthController {
  constructor(private readonly google: GoogleAuthService) {}

  @UseGuards(JwtAuthGuard)
  @Get('auth/url')
  getGoogleAuthUrl(@Request() req: AuthenticatedRequest) {
    return this.google.getAuthUrl(req.user.id);
  }

  // Deliberately unguarded and a GET, unlike Instagram's callback: Google
  // redirects the user's own browser tab here directly, with the code/state
  // in the query string and no Authorization header to attach.
  @Get('auth/callback')
  async handleGoogleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      res
        .type('html')
        .send(
          landingPage(
            'Google sign-in cancelled',
            `Google reported: ${error}. You can close this tab.`,
          ),
        );
      return;
    }
    if (!code || !state) {
      res
        .status(400)
        .type('html')
        .send(
          landingPage(
            'Missing information',
            'Google did not send back a code — close this tab and try connecting again.',
          ),
        );
      return;
    }

    try {
      const { email } = await this.google.handleCallback(code, state);
      res
        .type('html')
        .send(
          landingPage(
            'Google connected',
            `Connected as ${email}. You can close this tab and return to the app.`,
          ),
        );
    } catch (e) {
      res
        .status(400)
        .type('html')
        .send(
          landingPage(
            'Could not connect Google',
            e instanceof Error ? e.message : 'Something went wrong. Close this tab and try again.',
          ),
        );
    }
  }
}
