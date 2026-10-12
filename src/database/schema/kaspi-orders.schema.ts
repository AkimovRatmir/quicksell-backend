import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sellers } from './sellers.schema';

/**
 * A seller's Kaspi order, as returned by the OFFICIAL Kaspi Shop API
 * `GET kaspi.kz/shop/api/v2/orders` (X-Auth-Token auth). One row per
 * (seller, code). Unlike products (fragile cabinet-cookie BFF), this uses the
 * documented token API — no cookie expiry.
 *
 * We currently sync `state = ARCHIVE` (completed/cancelled history) for
 * analytics. Rows are upserted on every sync so an order's `status` stays
 * current if it changes. The full API `attributes` object is kept in `raw` so
 * we never lose a field we didn't promote to a column.
 *
 * NOTE: the Orders API does NOT expose Kaspi commission or net payout — those
 * live only in the cabinet Excel export. If needed, they must be supplied
 * separately (per-category commission config or an Excel import).
 */
export const kaspiOrders = pgTable(
  'kaspi_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    /** Kaspi order number, e.g. "900000001". */
    code: text('code').notNull(),
    /** NEW | SIGN_REQUIRED | PICKUP | DELIVERY | KASPI_DELIVERY | ARCHIVE */
    state: text('state').notNull(),
    /** COMPLETED | CANCELLED | ... */
    status: text('status').notNull(),
    /** All money in tenge (Kaspi returns floats; rounded on ingest). */
    totalPrice: integer('total_price').notNull().default(0),
    /** Delivery cost charged to the customer. */
    deliveryCost: integer('delivery_cost').notNull().default(0),
    /** Delivery cost borne by the seller (Kaspi Delivery). */
    deliveryCostForSeller: integer('delivery_cost_for_seller')
      .notNull()
      .default(0),
    paymentMode: text('payment_mode'),
    deliveryMode: text('delivery_mode'),
    isKaspiDelivery: boolean('is_kaspi_delivery').notNull().default(false),
    preOrder: boolean('pre_order').notNull().default(false),
    signatureRequired: boolean('signature_required').notNull().default(false),
    assembled: boolean('assembled').notNull().default(false),
    pickupPointId: text('pickup_point_id'),
    /** Customer name; Kaspi masks the phone (e.g. "+0(000)-000-00-00"). */
    customerName: text('customer_name'),
    customerCell: text('customer_cell'),
    deliveryTown: text('delivery_town'),
    creationDate: timestamp('creation_date', { withTimezone: true }),
    approvedByBankDate: timestamp('approved_by_bank_date', {
      withTimezone: true,
    }),
    completionDate: timestamp('completion_date', { withTimezone: true }),
    entriesCount: integer('entries_count').notNull().default(0),
    /** Why the order was cancelled (e.g. BUYER_CANCELLATION_HIMSELF). NULL if not. */
    cancellationReason: text('cancellation_reason'),
    /** Kaspi installment term in months (3/6/12/24). NULL = paid in full. */
    creditTerm: integer('credit_term'),
    syncedAt: timestamp('synced_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('uq_kaspi_orders_seller_code').on(t.sellerId, t.code),
    index('idx_kaspi_orders_seller').on(t.sellerId),
    index('idx_kaspi_orders_seller_created').on(t.sellerId, t.creationDate),
    index('idx_kaspi_orders_seller_status').on(t.sellerId, t.status),
  ],
);

/**
 * One line item of a Kaspi order (`/orders/{id}/entries`). Enables
 * revenue-by-product and margin (join `offerCode` → kaspi_products / its
 * `costPrice`). One row per (order, entryNumber).
 */
export const kaspiOrderEntries = pgTable(
  'kaspi_order_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => kaspiOrders.id, { onDelete: 'cascade' }),
    /** Denormalized for fast per-seller product analytics. */
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    entryNumber: integer('entry_number').notNull().default(0),
    /** Kaspi offer/product code — join key to product analytics. */
    offerCode: text('offer_code'),
    offerName: text('offer_name'),
    categoryCode: text('category_code'),
    categoryTitle: text('category_title'),
    barCode: text('bar_code'),
    quantity: integer('quantity').notNull().default(0),
    /** Unit price (tenge). */
    basePrice: integer('base_price').notNull().default(0),
    /** Line total (tenge). */
    totalPrice: integer('total_price').notNull().default(0),
    unitType: text('unit_type'),
  },
  (t) => [
    unique('uq_kaspi_order_entries_order_entry').on(t.orderId, t.entryNumber),
    index('idx_kaspi_order_entries_order').on(t.orderId),
    index('idx_kaspi_order_entries_seller_offer').on(t.sellerId, t.offerCode),
  ],
);

export type KaspiOrderRow = typeof kaspiOrders.$inferSelect;
export type NewKaspiOrder = typeof kaspiOrders.$inferInsert;
export type KaspiOrderEntryRow = typeof kaspiOrderEntries.$inferSelect;
export type NewKaspiOrderEntry = typeof kaspiOrderEntries.$inferInsert;
