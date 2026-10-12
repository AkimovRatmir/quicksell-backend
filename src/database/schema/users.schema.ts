import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Subscription tiers. */
export const PLANS = ['free', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

/** Access roles. Admins reach the internal admin panel. */
export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * An account of *our* analytics product. Owns one or more Kaspi sellers.
 * `passwordHash` is a one-way scrypt hash — never reversible.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  /** Subscription plan: 'free' (default) | 'pro'. */
  plan: text('plan').notNull().default('free'),
  /**
   * When a paid Pro runs out; the billing scheduler then moves the account
   * back to 'free'. NULL on 'pro' = no end date (granted from the admin panel).
   */
  planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
  /** Access role: 'user' (default) | 'admin'. */
  role: text('role').notNull().default('user'),
  /**
   * When the password was last changed through a reset. Any JWT issued before
   * this moment is refused, so resetting a password also logs out whoever was
   * already signed in with the old one. NULL = never reset.
   */
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
