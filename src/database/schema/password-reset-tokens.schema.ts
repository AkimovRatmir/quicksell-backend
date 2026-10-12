import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * One "forgot my password" request.
 *
 * Only the SHA-256 of the token is stored: the raw value exists in the email
 * and nowhere else, so a database leak cannot be turned into a password reset.
 *
 * Rows are kept after use (`usedAt`) rather than deleted — a used token must be
 * recognisably used, not merely absent, and the history is what the per-account
 * rate limit counts. Expired rows are swept on the next request.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the token sent in the link. Unique per request. */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set the moment the token is spent. NULL = still usable. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /** Who asked for the reset — evidence if an account is being targeted. */
    requestedIp: text('requested_ip'),
    requestedUserAgent: text('requested_user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_password_reset_user').on(t.userId, t.createdAt),
    index('idx_password_reset_expires').on(t.expiresAt),
  ],
);

export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
