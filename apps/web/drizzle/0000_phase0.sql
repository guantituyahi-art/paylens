CREATE TABLE "developers" (
  "id" uuid PRIMARY KEY,
  "email" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "developer_id" uuid NOT NULL REFERENCES "developers"("id"),
  "name" text NOT NULL,
  "timezone" text NOT NULL,
  "retention_days" integer NOT NULL DEFAULT 365,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "projects_developer_id_idx" ON "projects" ("developer_id");
--> statement-breakpoint
CREATE TABLE "project_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "key" text NOT NULL UNIQUE,
  "label" text,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "deprecated_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "project_keys_status_check" CHECK ("status" IN ('active', 'deprecated', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX "project_keys_project_id_idx" ON "project_keys" ("project_id");
