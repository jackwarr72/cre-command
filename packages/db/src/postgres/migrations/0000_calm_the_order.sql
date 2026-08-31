CREATE TYPE "public"."crawl_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('active', 'pending', 'sold', 'leased', 'off-market', 'removed');--> statement-breakpoint
CREATE TYPE "public"."listing_type" AS ENUM('sale', 'lease', 'sale-or-lease');--> statement-breakpoint
CREATE TYPE "public"."price_unit" AS ENUM('total', 'sqft', 'sqft-month', 'sqft-year', 'month');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('office', 'retail', 'industrial', 'multifamily', 'land', 'mixed-use', 'special-purpose', 'healthcare', 'hospitality', 'agriculture', 'other');--> statement-breakpoint
CREATE TYPE "public"."robots_policy" AS ENUM('strict', 'honor', 'allow');--> statement-breakpoint
CREATE TYPE "public"."size_unit" AS ENUM('sqft', 'sqm', 'acre');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"company" text,
	"title" text,
	"email" text,
	"phone" text,
	"website" text,
	"source_key" text,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crawl_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"status" "crawl_run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"listings_found" integer DEFAULT 0 NOT NULL,
	"listings_added" integer DEFAULT 0 NOT NULL,
	"listings_updated" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listing_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"observed_at" timestamp DEFAULT now() NOT NULL,
	"source_url" text,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"source_url" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"property_type" "property_type" NOT NULL,
	"listing_type" "listing_type" NOT NULL,
	"status" "listing_status" DEFAULT 'active' NOT NULL,
	"street_address" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'MX' NOT NULL,
	"formatted_address" text,
	"lat" numeric(10, 7),
	"lng" numeric(10, 7),
	"price_amount" numeric(16, 2),
	"price_currency" text,
	"price_unit" "price_unit",
	"size_value" numeric(12, 2),
	"size_unit" "size_unit",
	"lot_size_value" numeric(12, 2),
	"lot_size_unit" "size_unit",
	"year_built" integer,
	"unit_count" integer,
	"listed_at" timestamp,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"raw" jsonb,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" text DEFAULT '0 3 * * *' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"crawl_allowed" boolean DEFAULT true NOT NULL,
	"robots_policy" "robots_policy" DEFAULT 'strict' NOT NULL,
	"rate_limit_ms" integer DEFAULT 500 NOT NULL,
	"max_workers" integer DEFAULT 1 NOT NULL,
	"authentication_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listing_observations" ADD CONSTRAINT "listing_observations_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "listings" ADD CONSTRAINT "listings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_source_key_idx" ON "contacts" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contacts_email_idx" ON "contacts" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crawl_runs_source_idx" ON "crawl_runs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crawl_runs_status_idx" ON "crawl_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crawl_runs_created_idx" ON "crawl_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listing_observations_listing_idx" ON "listing_observations" USING btree ("listing_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listings_source_external_uidx" ON "listings" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_status_idx" ON "listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_property_type_idx" ON "listings" USING btree ("property_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_location_idx" ON "listings" USING btree ("city","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_last_seen_idx" ON "listings" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sources_key_uidx" ON "sources" USING btree ("key");