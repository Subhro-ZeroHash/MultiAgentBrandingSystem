import { Body, Controller, Get, Post, Request, UseGuards } from '@nestjs/common';
import { loginInputSchema, signupInputSchema, type AuthUser } from '@bmas/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  signup(@Body(new ZodValidationPipe(signupInputSchema)) body: unknown) {
    return this.auth.signup(body as Parameters<AuthService['signup']>[0]);
  }

  @Post('login')
  login(@Body(new ZodValidationPipe(loginInputSchema)) body: unknown) {
    return this.auth.login(body as Parameters<AuthService['login']>[0]);
  }

  /** Stateless JWT: nothing to invalidate server-side. Exists so the client
   *  has a symmetric call to make and a place to hang server-side revocation
   *  later (e.g. a token blocklist) without changing the frontend contract. */
  @Post('logout')
  logout() {
    return { ok: true };
  }

  /** Lets the app verify a stored token on launch and recover the user it
   *  belongs to, without re-sending credentials. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Request() req: { user: AuthUser }) {
    return req.user;
  }
}
