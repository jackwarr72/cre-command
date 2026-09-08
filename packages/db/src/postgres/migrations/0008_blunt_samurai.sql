-- Migration 0008: Add worker execution fields to crawl_runs.
-- Supports the transactional outbox + worker architecture:
--   - urls: persisted crawl parameters so workers don't need to re-resolve
--   - requested_by_user_id: audit trail for who triggered the run
--   - worker_id: idempotency claim so multiple workers don't execute the same run

ALTER TABLE "crawl_runs" ADD COLUMN IF NOT EXISTS "urls" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "crawl_runs" ADD COLUMN IF NOT EXISTS "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null;
ALTER TABLE "crawl_runs" ADD COLUMN IF NOT EXISTS "worker_id" text;
CREATE INDEX IF NOT EXISTS "crawl_runs_requested_by_idx" ON "crawl_runs" USING btree ("requested_by_user_id");