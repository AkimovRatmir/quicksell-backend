CREATE TABLE "product_cost_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"cost" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_cost_hist_point" UNIQUE("seller_id","sku","effective_from")
);
--> statement-breakpoint
CREATE TABLE "product_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"price" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'kaspi_sync' NOT NULL,
	CONSTRAINT "uq_price_hist_point" UNIQUE("seller_id","sku","observed_at","source")
);
--> statement-breakpoint
ALTER TABLE "product_cost_history" ADD CONSTRAINT "product_cost_history_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_price_history" ADD CONSTRAINT "product_price_history_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cost_hist_seller_sku" ON "product_cost_history" USING btree ("seller_id","sku","effective_from");--> statement-breakpoint
CREATE INDEX "idx_price_hist_seller_sku" ON "product_price_history" USING btree ("seller_id","sku","observed_at");--> statement-breakpoint

-- Засев истории себестоимости из текущего cost_price. Без него «ИСТОРИЯ
-- СЕБЕСТОИМОСТИ» была бы пуста у всех, кто уже завёл закупку. Дата начала
-- действия — самый ранний заказ продавца, чтобы эта себестоимость покрыла всю
-- уже посчитанную историю и прибыль за прошлые периоды на деплое НЕ поехала.
INSERT INTO "product_cost_history" ("seller_id", "sku", "cost", "effective_from")
SELECT p."seller_id", p."sku", p."cost_price",
       COALESCE(
         (SELECT min(o."creation_date") FROM "kaspi_orders" o
           WHERE o."seller_id" = p."seller_id"),
         now()
       )
  FROM "kaspi_products" p
 WHERE p."cost_price" IS NOT NULL
ON CONFLICT ON CONSTRAINT "uq_cost_hist_point" DO NOTHING;--> statement-breakpoint

-- Засев истории цены из позиций заказов. Kaspi не отдаёт историю цен, так что
-- это единственное реальное прошлое, которое у нас есть. Это цена, ПО КОТОРОЙ
-- КУПИЛИ, а не цена с витрины — отсюда source='order'.
-- Берём только дни, когда цена изменилась: иначе у ходового товара вышла бы
-- строка на каждый день продаж вместо списка изменений.
WITH daily AS (
  SELECT o."seller_id" AS seller_id,
         e."offer_code" AS sku,
         round(sum(e."total_price")::numeric / sum(e."quantity"))::int AS price,
         date_trunc('day', o."creation_date") AS day
    FROM "kaspi_order_entries" e
    JOIN "kaspi_orders" o ON o."id" = e."order_id"
   WHERE o."status" = 'COMPLETED' AND e."quantity" > 0
   GROUP BY o."seller_id", e."offer_code", date_trunc('day', o."creation_date")
), marked AS (
  SELECT seller_id, sku, price, day,
         lag(price) OVER (PARTITION BY seller_id, sku ORDER BY day) AS prev
    FROM daily
)
INSERT INTO "product_price_history" ("seller_id", "sku", "price", "observed_at", "source")
SELECT seller_id, sku, price, day, 'order'
  FROM marked
 WHERE prev IS NULL OR prev <> price
ON CONFLICT ON CONSTRAINT "uq_price_hist_point" DO NOTHING;