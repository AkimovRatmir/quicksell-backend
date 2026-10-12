import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { eq } from 'drizzle-orm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import { users } from '../database/schema';

export interface JwtPayload {
  sub: string;
  email: string;
  /** Issued-at, seconds since epoch. Added by jsonwebtoken when signing. */
  iat?: number;
}

export interface AuthUser {
  userId: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Tokens are valid for 7 days, so a password reset has to be able to cut one
   * short: otherwise whoever was already signed in with the old password keeps
   * their session, which is usually the exact person the reset is meant to
   * lock out. A token issued before the last reset is refused.
   *
   * Costs one indexed lookup per authenticated request. `passwordChangedAt` is
   * NULL for accounts that never reset, which is the common case.
   */
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const [user] = await this.db
      .select({ passwordChangedAt: users.passwordChangedAt })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1);
    if (!user) throw new UnauthorizedException('Account no longer exists');

    if (user.passwordChangedAt && payload.iat) {
      // iat has second precision; a token minted in the same second as the
      // reset is the one we just issued, so compare on whole seconds.
      const changedAtSec = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (payload.iat < changedAtSec) {
        throw new UnauthorizedException('Пароль был изменён — войдите заново.');
      }
    }

    return { userId: payload.sub, email: payload.email };
  }
}
