import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * A Kaspi seller (merchant account) owned by one of our users.
 *
 * All Kaspi secrets are stored AES-256-GCM encrypted (see crypto.util) — the
 * `*Enc` columns hold ciphertext blobs, never plaintext. Never log/return them.
 *
 * - `kaspiSessionCookieEnc`: browser session cookie for the internal cabinet
 *   API (products). Expires → `cookieStatus` becomes 'needs_reauth'.
 * - `kaspiDeviceCookiesEnc`: the FULL login cookie jar (JSON) incl. the
 *   trusted-device cookie from an `_r_d:true` MFA verify. Replaying it lets us
 *   re-login silently (no email code) until Kaspi expires the device trust.
 * - `kaspiApiTokenEnc`: official X-Auth-Token (future orders/sales).
 * - `kaspiLoginEnc` / `kaspiPasswordEnc`: for the auto-login refresher.
 */
export const sellers = pgTable(
  'sellers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kaspiMerchantUid: text('kaspi_merchant_uid').notNull(),

    kaspiSessionCookieEnc: text('kaspi_session_cookie_enc'),
    kaspiDeviceCookiesEnc: text('kaspi_device_cookies_enc'),
    kaspiApiTokenEnc: text('kaspi_api_token_enc'),
    kaspiLoginEnc: text('kaspi_login_enc'),
    kaspiPasswordEnc: text('kaspi_password_enc'),

    /** 'ok' | 'needs_reauth' */
    cookieStatus: text('cookie_status').notNull().default('ok'),
    /**
     * When an automatic re-login was answered by Kaspi with "enter the code we
     * just emailed". While set, syncs do not run the password step again: each
     * attempt makes Kaspi email the seller another code, so an hourly cron would
     * send one every hour. Cleared when the seller re-verifies (or saves new
     * credentials); only the interactive re-auth asks Kaspi for a code again.
     */
    kaspiCodeRequiredAt: timestamp('kaspi_code_required_at', {
      withTimezone: true,
    }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // A user connects a given Kaspi shop exactly once. Prevents the same
    // real merchant becoming multiple seller rows (which would multiply-count
    // money in any cross-seller aggregation).
    unique('uq_sellers_user_merchant').on(t.userId, t.kaspiMerchantUid),
  ],
);

export type SellerRow = typeof sellers.$inferSelect;
export type NewSeller = typeof sellers.$inferInsert;
