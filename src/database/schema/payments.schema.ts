import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/** Lifecycle of one payment attempt. */
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * One attempt to pay for a subscription through FreedomPay.
 *
 * The row is created before the user sees the payment form, and its `id` is
 * the `pg_order_id` FreedomPay echoes back in every callback — so a callback
 * can only ever touch the payment it was created for.
 *
 * `pending` → `paid` | `failed`. A `failed` payment may still turn `paid`: a
 * status check can give up before FreedomPay's own retries report the money
 * as taken, and a charged customer must get what they paid for. Pro is granted
 * exactly once, on the transition into `paid`.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Plan being bought — 'pro'. */
    plan: text('plan').notNull(),
    /** Whole tenge. The price is fixed on our side, never taken from the browser. */
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('KZT'),
    status: text('status').notNull().default('pending'),
    /** Created with pg_testing_mode=1: never grants Pro on a live setup. */
    testMode: boolean('test_mode').notNull(),
    /** FreedomPay's pg_payment_id. NULL until init_payment answers. */
    providerPaymentId: text('provider_payment_id'),
    /** Masked card, e.g. 4444-44XX-XXXX-6666 — for support, never the full PAN. */
    cardPan: text('card_pan'),
    /** Why the payment failed, as FreedomPay or our checks put it. */
    failureReason: text('failure_reason'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** The plan end date this payment produced. */
    paidUntil: timestamp('paid_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_payments_user').on(t.userId),
    index('idx_payments_status').on(t.status, t.createdAt),
  ],
);

export type PaymentRow = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
