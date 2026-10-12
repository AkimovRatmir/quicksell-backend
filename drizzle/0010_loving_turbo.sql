CREATE TABLE "unit_economics_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sale_price" integer NOT NULL,
	"cost_price" integer DEFAULT 0 NOT NULL,
	"kaspi_commission_pct" numeric(6, 2) DEFAULT '0' NOT NULL,
	"delivery_to_customer" integer DEFAULT 0 NOT NULL,
	"delivery_to_warehouse" integer DEFAULT 0 NOT NULL,
	"packaging" integer DEFAULT 0 NOT NULL,
	"advertising_per_unit" integer DEFAULT 0 NOT NULL,
	"returns_pct" numeric(6, 2) DEFAULT '0' NOT NULL,
	"other_expenses" integer DEFAULT 0 NOT NULL,
	"sales_per_month" integer DEFAULT 0 NOT NULL,
	"target_margin_pct" numeric(6, 2) DEFAULT '0' NOT NULL,
	"total_cost_per_unit" integer NOT NULL,
	"profit_per_unit" integer NOT NULL,
	"margin_pct" numeric(8, 2) NOT NULL,
	"roi_pct" numeric(10, 2),
	"monthly_profit" integer NOT NULL,
	"recommended_price" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "unit_economics_calculations" ADD CONSTRAINT "unit_economics_calculations_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_economics_calculations" ADD CONSTRAINT "unit_economics_calculations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_unit_econ_seller_created" ON "unit_economics_calculations" USING btree ("seller_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_unit_econ_user_created" ON "unit_economics_calculations" USING btree ("user_id","created_at");