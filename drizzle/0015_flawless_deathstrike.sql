CREATE TABLE "user_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_code" text NOT NULL,
	"document_version" text NOT NULL,
	"document_title" text NOT NULL,
	"context" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_consents_user" ON "user_consents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_consents_document" ON "user_consents" USING btree ("document_code","document_version");