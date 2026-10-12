import {
  boolean,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sellers } from './sellers.schema';

/**
 * Per-seller analytics configuration (the "Цели бизнеса" + global toggles from
 * the Settings screen). Exactly one row per seller.
 *
 * Percentages are stored as exact NUMERIC (never float) since they feed money
 * math — e.g. 20.00 means "20%".
 */
export const sellerSettings = pgTable('seller_settings', {
  sellerId: uuid('seller_id')
    .primaryKey()
    .references(() => sellers.id, { onDelete: 'cascade' }),
  /** «Применять ко всем товарам автоматически» — apply expense categories to
   *  every product when computing unit economics. */
  applyExpensesAuto: boolean('apply_expenses_auto').notNull().default(true),
  /** «Хочу зарабатывать» — target profit, % of sale price. */
  targetProfitPct: numeric('target_profit_pct', { precision: 6, scale: 2 })
    .notNull()
    .default('20'),
  /** «Минимум допустимый» — minimum acceptable profit, % of sale price. */
  minProfitPct: numeric('min_profit_pct', { precision: 6, scale: 2 })
    .notNull()
    .default('10'),
  /** «Налоги» — tax rate applied to revenue, %. */
  taxPercent: numeric('tax_percent', { precision: 6, scale: 2 })
    .notNull()
    .default('0'),
  /** «Окупаемость за» — target payback period, months. */
  paybackMonths: integer('payback_months').notNull().default(3),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SellerSettingsRow = typeof sellerSettings.$inferSelect;
export type NewSellerSettings = typeof sellerSettings.$inferInsert;
