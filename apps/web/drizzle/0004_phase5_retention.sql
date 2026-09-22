-- Phase 5 retention: delete events/feedback older than each project's retention_days.
-- ai_reports are kept (aggregated snapshots; comment theme examples are already redacted).
-- Data impact when this job runs in production: irreversible DELETE of old events/feedback only.
-- Rollback: SELECT cron.unschedule('paylens-retention-cleanup');
-- Do not run this migration from verify scripts (PGlite has no pg_cron). Apply only on Postgres/Supabase.

CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint
SELECT cron.schedule(
  'paylens-retention-cleanup',
  '15 3 * * *',
  $$
  DELETE FROM events e
  USING projects p
  WHERE e.project_id = p.id
    AND e.occurred_at < (now() - make_interval(days => p.retention_days));

  DELETE FROM feedback f
  USING projects p
  WHERE f.project_id = p.id
    AND f.occurred_at < (now() - make_interval(days => p.retention_days));
  $$
);
