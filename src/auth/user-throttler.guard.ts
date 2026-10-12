import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthUser } from './jwt.strategy';

/**
 * Rate limit keyed on the signed-in user instead of the client IP.
 *
 * For routes behind JwtAuthGuard the IP is the wrong key: a team in one office
 * shares an address and would share a limit, while one person with a pool of
 * IPs would get a fresh limit per address. The account is what we want to cap.
 *
 * Must run after JwtAuthGuard so `req.user` is set — class-level guards run
 * before method-level ones, which is how the controllers apply it. Falls back
 * to the IP if a route ever uses it without authentication.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as AuthUser | undefined;
    return Promise.resolve(
      user?.userId ? `user:${user.userId}` : String(req.ip),
    );
  }
}
