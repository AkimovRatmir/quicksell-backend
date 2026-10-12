import {
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sellers } from './sellers.schema';

/**
 * A per-seller expense category applied per product unit («Категории расходов»).
 * Kaspi commission lives here too — the Orders API doesn't expose it, so the
 * seller configures it as a category (default 15%).
 *
 * `kind` decides how `value` is read:
 *   - 'percent' → value is a % of the sale price (e.g. 15.00 = 15%)
 *   - 'fixed'   → value is tenge per unit (e.g. 150.00 = 150 ₸)
 *
 * Value is exact NUMERIC (never float) — it feeds unit-economics money math.
 */
export const sellerExpenseCategories = pgTable(
  'seller_expense_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 'percent' | 'fixed' */
    kind: text('kind').notNull(),
    value: numeric('value', { precision: 12, scale: 2 }).notNull().default('0'),
    /** UI dot color (hex), optional. */
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_seller_expense_categories_seller').on(t.sellerId)],
);

export type SellerExpenseCategoryRow =
  typeof sellerExpenseCategories.$inferSelect;
export type NewSellerExpenseCategory =
  typeof sellerExpenseCategories.$inferInsert;
