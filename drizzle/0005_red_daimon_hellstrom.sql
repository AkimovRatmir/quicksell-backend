CREATE TABLE "seller_settings" (
	"seller_id" uuid PRIMARY KEY NOT NULL,
	"apply_expenses_auto" boolean DEFAULT true NOT NULL,
	"target_profit_pct" numeric(6, 2) DEFAULT '20' NOT NULL,
	"min_profit_pct" numeric(6, 2) DEFAULT '10' NOT NULL,
	"payback_months" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seller_expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seller_settings" ADD CONSTRAINT "seller_settings_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_expense_categories" ADD CONSTRAINT "seller_expense_categories_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_seller_expense_categories_seller" ON "seller_expense_categories" USING btree ("seller_id");