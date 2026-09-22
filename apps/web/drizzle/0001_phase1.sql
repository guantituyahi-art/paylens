CREATE TABLE "events" (
  "id" bigserial PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL,
  "anonymous_user_id" text NOT NULL,
  "paywall_session_id" uuid NOT NULL,
  "event_name" text NOT NULL,
  "platform" text NOT NULL,
  "app_version" text NOT NULL,
  "paywall_version" text,
  "product_id" text,
  "occurred_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "events_project_event_unique" UNIQUE ("project_id", "event_id")
);
--> statement-breakpoint
CREATE INDEX "events_project_occurred_idx" ON "events" ("project_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "events_project_name_occurred_idx" ON "events" ("project_id", "event_name", "occurred_at");
--> statement-breakpoint
CREATE INDEX "events_project_session_idx" ON "events" ("project_id", "paywall_session_id");
--> statement-breakpoint
CREATE INDEX "events_project_user_idx" ON "events" ("project_id", "anonymous_user_id");
--> statement-breakpoint
CREATE TABLE "project_daily_usage" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "event_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("project_id", "day")
);
