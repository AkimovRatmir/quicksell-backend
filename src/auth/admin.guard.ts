import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import { users } from '../database/schema';
import type { AuthUser } from './jwt.strategy';

/**
 * Allows the request only if the authenticated user has role='admin'.
 * Runs AFTER JwtAuthGuard (which populates req.user). The role is read fresh
 * from the DB on every call, so revoking admin takes effect immediately (the
 * JWT itself never carries the role).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const userId = req.user?.userId;
    if (!userId) throw new ForbiddenException('Not authenticated');

    const [row] = await this.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (row?.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
