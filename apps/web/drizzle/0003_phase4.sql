CREATE TABLE "ai_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "timezone" text NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "compare_start" date NOT NULL,
  "compare_end" date NOT NULL,
  "filters" jsonb NOT NULL DEFAULT '{}',
  "status" text NOT NULL,
  "model" text,
  "prompt_version" text,
  "input_snapshot" jsonb,
  "output" jsonb,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_reports_status_check" CHECK ("status" IN ('pending', 'done', 'failed', 'insufficient_data'))
);
--> statement-breakpoint
CREATE INDEX "ai_reports_project_created_idx" ON "ai_reports" ("project_id", "created_at" DESC);
