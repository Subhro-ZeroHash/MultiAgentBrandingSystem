import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Applied per-controller/route with `@UseGuards(JwtAuthGuard)`. On success,
 *  attaches `JwtStrategy.validate`'s return value to `req.user`. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
