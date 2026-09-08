-- Migration 0005: audit_log (append-only security/policy trail).
-- Hand-trimmed to the audit_log delta: drizzle-kit generated a full-schema
-- dump here (stale 0004 snapshot) whose unguarded CREATE TYPE statements
-- would fail on databases already migrated by 0000-0004.

CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_at_idx" ON "audit_log" USING btree ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log" USING btree ("action");