-- Phase 7: optional columns for purchase_failed and stored comment themes.
-- Existing rows stay null. Rollback, only if you have not come to rely on the new event:
--   DROP INDEX IF EXISTS events_viewed_idx;
--   ALTER TABLE events DROP CONSTRAINT IF EXISTS events_failure_kind_check;
--   ALTER TABLE events DROP COLUMN IF EXISTS failure_kind, DROP COLUMN IF EXISTS sdk_version;
--   ALTER TABLE feedback DROP COLUMN IF EXISTS sdk_version, DROP COLUMN IF EXISTS theme, DROP COLUMN IF EXISTS theme_version;
-- purchase_failed rows must be deleted before dropping failure_kind, because the check requires that column.

ALTER TABLE "events" ADD COLUMN "failure_kind" text;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "sdk_version" text;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_failure_kind_check" CHECK (
  ("event_name" = 'purchase_failed' AND "failure_kind" IN ('user_cancelled', 'payment_error', 'unknown'))
  OR ("event_name" <> 'purchase_failed' AND "failure_kind" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "sdk_version" text;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "theme" text;
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "theme_version" text;
--> statement-breakpoint
CREATE INDEX "events_viewed_idx" ON "events" ("project_id", "occurred_at") WHERE "event_name" = 'paywall_viewed';
