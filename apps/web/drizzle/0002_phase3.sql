CREATE TABLE "feedback" (
  "id" bigserial PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "feedback_id" uuid NOT NULL,
  "anonymous_user_id" text NOT NULL,
  "paywall_session_id" uuid NOT NULL,
  "reason_code" text NOT NULL,
  "reason_label" text,
  "comment" text,
  "platform" text NOT NULL,
  "app_version" text NOT NULL,
  "paywall_version" text,
  "occurred_at" timestamptz NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "feedback_project_feedback_unique" UNIQUE ("project_id", "feedback_id")
);
--> statement-breakpoint
CREATE INDEX "feedback_project_occurred_idx" ON "feedback" ("project_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "feedback_project_reason_occurred_idx" ON "feedback" ("project_id", "reason_code", "occurred_at");
--> statement-breakpoint
CREATE INDEX "feedback_project_session_idx" ON "feedback" ("project_id", "paywall_session_id");
--> statement-breakpoint
CREATE INDEX "feedback_project_user_idx" ON "feedback" ("project_id", "anonymous_user_id");
