import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, schema, type Database } from '@bmas/db';
import type { AuthResponse, AuthUser, LoginInput, SignupInput } from '@bmas/shared';
import * as bcrypt from 'bcrypt';
import { DATABASE } from '../core/core.module.js';

/** Cost factor for bcrypt.hash. 12 is the current OWASP-recommended floor;
 *  raising it re-hashes nothing retroactively, so existing users stay on
 *  whatever cost they signed up under. */
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  private issueToken(user: AuthUser): string {
    return this.jwt.sign({ sub: user.id });
  }

  async signup(input: SignupInput): Promise<AuthResponse> {
    const [existing] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, input.email))
      .limit(1);
    if (existing) throw new ConflictException('An account with this email already exists.');

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const [row] = await this.db
      .insert(schema.users)
      .values({
        email: input.email,
        name: input.name ?? null,
        passwordHash,
      })
      .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name });
    if (!row) throw new Error('Failed to create account');

    return { user: row, token: this.issueToken(row) };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const [row] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.email, input.email))
      .limit(1);

    // Same message whether the email doesn't exist or the password is wrong —
    // distinguishing them would let a caller enumerate registered emails.
    const invalid = () => new UnauthorizedException('Invalid email or password.');
    if (!row || !row.passwordHash) throw invalid();

    const matches = await bcrypt.compare(input.password, row.passwordHash);
    if (!matches) throw invalid();

    const user: AuthUser = { id: row.id, email: row.email, name: row.name };
    return { user, token: this.issueToken(user) };
  }
}
