-- Migration 0004: Add MFA support (TOTP secrets and backup recovery codes)
-- Adds MFA configuration to users table with encrypted TOTP secret and one-time recovery codes.

--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Encrypted TOTP base32 secret. Encryption key from MFA_ENCRYPTION_KEY env var.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret_encrypted" text;
--> statement-breakpoint
-- AES-256-GCM IV (hex-encoded) used to encrypt the MFA secret
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret_iv" text;
--> statement-breakpoint
-- One-time recovery codes (bcrypt hashed), stored as JSON array
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_recovery_codes" text DEFAULT '[]'::text;
--> statement-breakpoint
-- Timestamp when MFA was last verified (for tracking)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_verified_at" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_mfa_enabled_idx" ON "users" USING btree ("mfa_enabled") WHERE "mfa_enabled" = true;
