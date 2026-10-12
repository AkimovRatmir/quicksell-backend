CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"distinct_id" text,
	"anonymous_id" text,
	"session_id" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_timestamp" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kaspi_merchant_uid" text NOT NULL,
	"kaspi_session_cookie_enc" text,
	"kaspi_api_token_enc" text,
	"kaspi_login_enc" text,
	"kaspi_password_enc" text,
	"cookie_status" text DEFAULT 'ok' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kaspi_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"offer_id" text,
	"title" text NOT NULL,
	"brand" text,
	"master_category" text,
	"price_min" integer DEFAULT 0 NOT NULL,
	"price_max" integer DEFAULT 0 NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"total_stock" integer DEFAULT 0 NOT NULL,
	"availabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"kaspi_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_kaspi_products_seller_sku" UNIQUE("seller_id","sku")
);
--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kaspi_products" ADD CONSTRAINT "kaspi_products_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_name_time" ON "events" USING btree ("event_name","event_timestamp");--> statement-breakpoint
CREATE INDEX "idx_events_time" ON "events" USING btree ("event_timestamp");--> statement-breakpoint
CREATE INDEX "idx_events_distinct" ON "events" USING btree ("distinct_id");--> statement-breakpoint
CREATE INDEX "idx_events_session" ON "events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_kaspi_products_seller" ON "kaspi_products" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "idx_kaspi_products_available" ON "kaspi_products" USING btree ("seller_id","available");