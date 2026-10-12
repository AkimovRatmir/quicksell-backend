CREATE TABLE "kaspi_auth_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"seller_id" uuid,
	"jar_enc" text NOT NULL,
	"email_sent_to" text NOT NULL,
	"login_enc" text NOT NULL,
	"password_enc" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sellers" ADD COLUMN "kaspi_device_cookies_enc" text;--> statement-breakpoint
ALTER TABLE "kaspi_auth_pending" ADD CONSTRAINT "kaspi_auth_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;