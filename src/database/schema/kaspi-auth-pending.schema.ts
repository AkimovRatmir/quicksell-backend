import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * A login stuck at the MFA step, waiting for the user to type the email code.
 *
 * Kaspi emails a 6-digit code after the password step; the user reads it and
 * posts it back. This row bridges those two requests: it holds the pre-auth
 * cookie jar (encrypted) plus what to do once the code checks out — connect a
 * new seller, or re-auth an existing one. Short-lived: the code expires in
 * ~180s, so anything past `expiresAt` is dead and gets swept.
 *
 * `jarEnc` and `passwordEnc` are AES-256-GCM ciphertext (see crypto.util) —
 * never plaintext, never logged, never returned to the client. The client only
 * ever sees this row's `id` (the opaque pending handle).
 */
export const kaspiAuthPending = pgTable('kaspi_auth_pending', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  /** 'connect' (new seller) | 'reauth' (refresh an existing seller). */
  purpose: text('purpose').notNull(),
  /** Set when purpose = 'reauth': the seller being refreshed. */
  sellerId: uuid('seller_id'),

  /** Encrypted MfaPending ({ jar, email }) from kaspi-auth.client. */
  jarEnc: text('jar_enc').notNull(),
  /** Email the code was sent to (shown in the UI). */
  emailSentTo: text('email_sent_to').notNull(),

  /** Encrypted login + password, carried through so we can store them on the
   *  seller after a successful connect. */
  loginEnc: text('login_enc').notNull(),
  passwordEnc: text('password_enc').notNull(),
  /** Non-secret connect params (name, kaspiMerchantUid, …). */
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type KaspiAuthPendingRow = typeof kaspiAuthPending.$inferSelect;
export type NewKaspiAuthPending = typeof kaspiAuthPending.$inferInsert;
