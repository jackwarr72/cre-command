-- Migration 0007: Add outbox table for transactional job queuing.
-- The outbox pattern ensures: a persisted queued crawl run will eventually
-- have a corresponding queue job, or be visibly recoverable as an
-- unpublished outbox record.

CREATE TABLE IF NOT EXISTS "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	/** Job type — allows reuse for CSV exports, notifications, CRM sync, SLA checks. */
	"type" text NOT NULL,
	/** Opaque payload for the worker; schema depends on type. */
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	/** Processing state. */
	"status" text NOT NULL DEFAULT 'pending',
	/** Number of processing attempts. */
	"attempts" integer NOT NULL DEFAULT 0,
	/** Error message from the last failed attempt. */
	"last_error" text,
	/** When the record was created. */
	"created_at" timestamp DEFAULT now() NOT NULL,
	/** When processing started (null if never picked up). */
	"started_at" timestamp,
	/** When processing completed (success or final failure). */
	"completed_at" timestamp,
	/** Optional correlation ID linking to a crawl run or other entity. */
	"correlation_id" uuid
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_status_created_idx" ON "outbox" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_correlation_idx" ON "outbox" USING btree ("correlation_id");