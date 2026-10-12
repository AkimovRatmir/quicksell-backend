CREATE TABLE "kaspi_order_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"entry_number" integer DEFAULT 0 NOT NULL,
	"offer_code" text,
	"offer_name" text,
	"category_code" text,
	"category_title" text,
	"bar_code" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"base_price" integer DEFAULT 0 NOT NULL,
	"total_price" integer DEFAULT 0 NOT NULL,
	"unit_type" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "uq_kaspi_order_entries_order_entry" UNIQUE("order_id","entry_number")
);
--> statement-breakpoint
CREATE TABLE "kaspi_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"code" text NOT NULL,
	"state" text NOT NULL,
	"status" text NOT NULL,
	"total_price" integer DEFAULT 0 NOT NULL,
	"delivery_cost" integer DEFAULT 0 NOT NULL,
	"delivery_cost_for_seller" integer DEFAULT 0 NOT NULL,
	"payment_mode" text,
	"delivery_mode" text,
	"is_kaspi_delivery" boolean DEFAULT false NOT NULL,
	"pre_order" boolean DEFAULT false NOT NULL,
	"signature_required" boolean DEFAULT false NOT NULL,
	"assembled" boolean DEFAULT false NOT NULL,
	"pickup_point_id" text,
	"customer_name" text,
	"customer_cell" text,
	"delivery_town" text,
	"creation_date" timestamp with time zone,
	"approved_by_bank_date" timestamp with time zone,
	"completion_date" timestamp with time zone,
	"entries_count" integer DEFAULT 0 NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_kaspi_orders_seller_code" UNIQUE("seller_id","code")
);
--> statement-breakpoint
ALTER TABLE "kaspi_order_entries" ADD CONSTRAINT "kaspi_order_entries_order_id_kaspi_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."kaspi_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaspi_order_entries" ADD CONSTRAINT "kaspi_order_entries_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaspi_orders" ADD CONSTRAINT "kaspi_orders_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_kaspi_order_entries_order" ON "kaspi_order_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_kaspi_order_entries_seller_offer" ON "kaspi_order_entries" USING btree ("seller_id","offer_code");--> statement-breakpoint
CREATE INDEX "idx_kaspi_orders_seller" ON "kaspi_orders" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "idx_kaspi_orders_seller_created" ON "kaspi_orders" USING btree ("seller_id","creation_date");--> statement-breakpoint
CREATE INDEX "idx_kaspi_orders_seller_status" ON "kaspi_orders" USING btree ("seller_id","status");