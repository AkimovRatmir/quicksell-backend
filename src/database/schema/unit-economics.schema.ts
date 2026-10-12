import {
  index,
  integer,
  numeric,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sellers } from './sellers.schema';
import { users } from './users.schema';

/**
 * A saved «Юнит-экономика» (unit economics) calculation. A standalone what-if
 * tool: the user enters product params, we compute per-unit profit / margin /
 * ROI / monthly profit and the cost structure, and snapshot it here for the
 * history list («Посмотреть историю расчётов») and the free-tier monthly quota.
 *
 * Money is stored as exact integer tenge; percentages as exact NUMERIC.
 * Both inputs and computed outputs are snapshotted so history stays truthful
 * even if formulas change later.
 */
export const unitEconomicsCalculations = pgTable(
  'unit_economics_calculations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    // Denormalized for the per-user monthly quota / ownership.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // --- inputs («Параметры товара») ---
    salePrice: integer('sale_price').notNull(),
    costPrice: integer('cost_price').notNull().default(0),
    kaspiCommissionPct: numeric('kaspi_commission_pct', { precision: 6, scale: 2 })
      .notNull()
      .default('0'),
    deliveryToCustomer: integer('delivery_to_customer').notNull().default(0),
    deliveryToWarehouse: integer('delivery_to_warehouse').notNull().default(0),
    packaging: integer('packaging').notNull().default(0),
    advertisingPerUnit: integer('advertising_per_unit').notNull().default(0),
    returnsPct: numeric('returns_pct', { precision: 6, scale: 2 })
      .notNull()
      .default('0'),
    otherExpenses: integer('other_expenses').notNull().default(0),
    salesPerMonth: integer('sales_per_month').notNull().default(0),
    targetMarginPct: numeric('target_margin_pct', { precision: 6, scale: 2 })
      .notNull()
      .default('0'),

    // --- outputs (snapshot) ---
    totalCostPerUnit: integer('total_cost_per_unit').notNull(),
    profitPerUnit: integer('profit_per_unit').notNull(),
    marginPct: numeric('margin_pct', { precision: 8, scale: 2 }).notNull(),
    roiPct: numeric('roi_pct', { precision: 10, scale: 2 }),
    monthlyProfit: integer('monthly_profit').notNull(),
    /** Price needed to hit the target margin. NULL if not computable. */
    recommendedPrice: integer('recommended_price'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_unit_econ_seller_created').on(t.sellerId, t.createdAt),
    index('idx_unit_econ_user_created').on(t.userId, t.createdAt),
  ],
);

export type UnitEconomicsRow = typeof unitEconomicsCalculations.$inferSelect;
export type NewUnitEconomics = typeof unitEconomicsCalculations.$inferInsert;
