import {
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
 * «История цены продажи» для карточки товара.
 *
 * `kaspi_products.price_min` — это цена ПРЯМО СЕЙЧАС: каждый синк её
 * перезаписывает, и прошлое значение исчезает. Здесь мы храним засечки, чтобы
 * продавец видел, как цена двигалась.
 *
 * `source` важен и не является служебным полем:
 *  - 'kaspi_sync' — цена с витрины Kaspi, снятая синком в момент её изменения;
 *  - 'order'      — цена, по которой товар РЕАЛЬНО купили (из позиций заказа).
 * Это разные факты: витринная цена могла быть 12 000 ₸, а продажа пройти по
 * 8 500 ₸ (акция, скидка). Kaspi не отдаёт историю цен, поэтому за прошлое у
 * нас есть только 'order', и смешивать их в одну линию нельзя молча.
 */
export const productPriceHistory = pgTable(
  'product_price_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    price: integer('price').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    source: text('source').notNull().default('kaspi_sync'),
  },
  (t) => [
    index('idx_price_hist_seller_sku').on(t.sellerId, t.sku, t.observedAt),
    // Один факт на (товар, момент, источник): делает засев из заказов и
    // повторные синки идемпотентными.
    unique('uq_price_hist_point').on(t.sellerId, t.sku, t.observedAt, t.source),
  ],
);

/**
 * «История себестоимости» — себестоимость, действующая С УКАЗАННОЙ ДАТЫ.
 *
 * До этого себестоимость была одним числом в `kaspi_products.cost_price`, и
 * она применялась ко ВСЕМ заказам, включая прошлогодние: стоило продавцу
 * поправить закупку сегодня — прибыль за прошлый месяц пересчитывалась задним
 * числом. Теперь COGS каждого заказа считается по себестоимости, которая
 * действовала на дату этого заказа.
 *
 * `cost_price` в kaspi_products остаётся как текущее значение (его правят
 * массовые операции и он же — запасной вариант, если истории по товару нет).
 */
export const productCostHistory = pgTable(
  'product_cost_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    cost: integer('cost').notNull(),
    /** С какой даты действует эта себестоимость. */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_cost_hist_seller_sku').on(t.sellerId, t.sku, t.effectiveFrom),
    // Две себестоимости с одной и той же датой начала действия сделали бы
    // выбор «какая действует» неоднозначным.
    unique('uq_cost_hist_point').on(t.sellerId, t.sku, t.effectiveFrom),
  ],
);

export type ProductPriceHistoryRow = typeof productPriceHistory.$inferSelect;
export type ProductCostHistoryRow = typeof productCostHistory.$inferSelect;
export type NewProductPriceHistory = typeof productPriceHistory.$inferInsert;
export type NewProductCostHistory = typeof productCostHistory.$inferInsert;
