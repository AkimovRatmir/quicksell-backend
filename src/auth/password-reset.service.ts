import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, eq, gt, gte, isNull, lte, sql } from 'drizzle-orm';
import { generateToken, hashPassword, hashToken } from '../crypto/crypto.util';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import { passwordResetTokens, users } from '../database/schema';
import { MailService } from '../mail/mail.service';
import { passwordResetEmail } from '../mail/templates/password-reset.template';

/** How long a link works. Long enough to find the email, short enough to matter. */
const TOKEN_TTL_MINUTES = 30;

/**
 * Per-account limits. Both are about the mailbox owner, not the requester: an
 * attacker who knows an email should not be able to flood that inbox (or our
 * sending quota) with reset messages.
 */
const MIN_SECONDS_BETWEEN_REQUESTS = 60;
const MAX_REQUESTS_PER_HOUR = 5;

/** Same reply whether or not the address exists — see `request()`. */
const NEUTRAL_REPLY = {
  message:
    'Если аккаунт с таким адресом существует, мы отправили на него письмо со ссылкой для восстановления пароля.',
} as const;

export interface ResetRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /** Where the link points — the frontend page that collects the new password. */
  private resetUrl(token: string): string {
    const base = (
      this.config.get<string>('APP_BASE_URL') ?? 'https://web.quicksell.kz'
    ).replace(/\/+$/, '');
    return `${base}/reset-password?token=${encodeURIComponent(token)}`;
  }

  /**
   * Start a reset.
   *
   * Always answers the same thing. Saying "no such account" here would turn
   * this endpoint into a way to test which emails are registered, so an unknown
   * address is answered exactly like a known one — same body, no error.
   */
  async request(email: string, meta: ResetRequestMeta = {}) {
    // Opportunistic sweep of dead rows; keeps the table to live requests.
    await this.db
      .delete(passwordResetTokens)
      .where(lte(passwordResetTokens.expiresAt, new Date()));

    const [user] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!user) {
      this.logger.log('Password reset requested for an unknown address');
      return NEUTRAL_REPLY;
    }

    // Over the limit: answer exactly as always and send nothing. Returning an
    // error here would make a rate-limited (real) account look different from
    // an unknown one, which is the enumeration hole the neutral reply closes.
    if (!(await this.withinLimits(user.id))) {
      this.logger.warn(
        `Password reset throttled for user ${user.id} — no email sent`,
      );
      return NEUTRAL_REPLY;
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000);
    await this.db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      requestedIp: meta.ip ?? null,
      requestedUserAgent: meta.userAgent ?? null,
    });

    await this.mail.send(
      passwordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl: this.resetUrl(token),
        expiresInMinutes: TOKEN_TTL_MINUTES,
      }),
    );

    this.logger.log(`Password reset email sent to user ${user.id}`);
    return NEUTRAL_REPLY;
  }

  /**
   * Is this link still good? Lets the frontend show "ссылка устарела" before
   * asking for a new password instead of after. Reveals nothing: without a
   * valid token the answer is always `false`.
   */
  async check(token: string): Promise<{ valid: boolean }> {
    return { valid: !!(await this.liveToken(token)) };
  }

  /**
   * Spend the token and set the new password.
   *
   * One transaction: the password changes, this token is marked used, and every
   * other outstanding token for the account is killed — a second reset email
   * sitting in the inbox must not still work afterwards. `passwordChangedAt`
   * invalidates sessions issued with the old password.
   */
  async reset(token: string, newPassword: string) {
    const row = await this.liveToken(token);
    if (!row) {
      throw new BadRequestException(
        'Ссылка недействительна или устарела. Запросите восстановление ещё раз.',
      );
    }

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: hashPassword(newPassword),
          passwordChangedAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, row.userId));

      await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(passwordResetTokens.userId, row.userId),
            isNull(passwordResetTokens.usedAt),
          ),
        );
    });

    this.logger.log(`Password reset completed for user ${row.userId}`);
    return { message: 'Пароль изменён. Войдите с новым паролем.' };
  }

  /** An unused, unexpired token row, or undefined. */
  private async liveToken(token: string) {
    const [row] = await this.db
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
      })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Is this account allowed another reset email right now?
   *
   * Both limits protect the mailbox owner: someone who knows an address must
   * not be able to bury that inbox in reset mail (or burn our sending quota)
   * by holding down a button.
   */
  private async withinLimits(userId: string): Promise<boolean> {
    const hourAgo = new Date(Date.now() - 3_600_000);
    const [stats] = await this.db
      .select({
        lastHour: count(),
        latest: sql<Date | null>`max(${passwordResetTokens.createdAt})`,
      })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          gte(passwordResetTokens.createdAt, hourAgo),
        ),
      );

    if (Number(stats.lastHour) >= MAX_REQUESTS_PER_HOUR) return false;

    const latest = stats.latest ? new Date(stats.latest) : null;
    return (
      !latest ||
      Date.now() - latest.getTime() >= MIN_SECONDS_BETWEEN_REQUESTS * 1000
    );
  }
}
