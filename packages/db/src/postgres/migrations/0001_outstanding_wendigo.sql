ALTER TYPE "public"."price_unit" ADD VALUE 'sqm' BEFORE 'month';--> statement-breakpoint
ALTER TYPE "public"."price_unit" ADD VALUE 'sqm-month' BEFORE 'month';--> statement-breakpoint
ALTER TYPE "public"."price_unit" ADD VALUE 'sqm-year' BEFORE 'month';