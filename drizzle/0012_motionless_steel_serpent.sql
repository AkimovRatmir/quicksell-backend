CREATE TABLE "ai_insights_cache" (
	"seller_id" uuid NOT NULL,
	"period" text NOT NULL,
	"model" text NOT NULL,
	"insights" jsonb NOT NULL,
	"based_on" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_insights_cache_seller_id_period_pk" PRIMARY KEY("seller_id","period")
);
--> statement-breakpoint
ALTER TABLE "ai_insights_cache" ADD CONSTRAINT "ai_insights_cache_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE cascade ON UPDATE no action;