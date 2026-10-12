import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sellers } from './sellers.schema';

/**
 * A seller's Kaspi offer (product), as returned by the internal cabinet BFF
 * `GET mc.shop.kaspi.kz/bff/offer-view/list`. One row per (seller, sku).
 *
 * Most columns are Kaspi-sourced and overwritten on every sync. `costPrice`
 * is user-supplied (seller's COGS) and is deliberately NOT in the sync's
 * upsert set, so it persists across syncs.
 *
 * Rows are NEVER deleted. When a SKU vanishes from a Kaspi sync, `archivedAt`
 * is set; the row (with its `costPrice`) is preserved forever and the listing
 * endpoint hides it by default. If the same SKU returns in a future sync, the
 * upsert clears `archivedAt` back to NULL and the row reactivates.
 */
export const kaspiProducts = pgTable(
  'kaspi_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    offerId: text('offer_id'),
    title: text('title').notNull(),
    brand: text('brand'),
    masterCategory: text('master_category'),
    priceMin: integer('price_min').notNull().default(0),
    priceMax: integer('price_max').notNull().default(0),
    available: boolean('available').notNull().default(false),
    totalStock: integer('total_stock').notNull().default(0),
    /** Raw per-store availability: [{ storeId, stockCount, available, ... }] */
    availabilities: jsonb('availabilities').notNull().default([]),
    images: jsonb('images').notNull().default([]),
    /** Seller-supplied cost of goods sold, in tenge. NULL = not set yet. */
    costPrice: integer('cost_price'),
    /** When the SKU vanished from a Kaspi sync. NULL = live on Kaspi. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    kaspiUpdatedAt: timestamp('kaspi_updated_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('uq_kaspi_products_seller_sku').on(t.sellerId, t.sku),
    index('idx_kaspi_products_seller').on(t.sellerId),
    index('idx_kaspi_products_available').on(t.sellerId, t.available),
    index('idx_kaspi_products_seller_archived').on(t.sellerId, t.archivedAt),
  ],
);

export type KaspiProductRow = typeof kaspiProducts.$inferSelect;
export type NewKaspiProduct = typeof kaspiProducts.$inferInsert;
