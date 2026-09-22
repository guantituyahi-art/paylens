-- First enable pg_cron in the Supabase console, then run `pnpm db:migrate`.
-- If cron.schedule fails because the job already exists, run
--   SELECT cron.unschedule('paylens-retention-cleanup');
-- then re-run this migration only — do not re-run earlier migrations.
--
-- Phase 5 retention: per-project retention_days, delete expired events/feedback.
-- ai_reports are kept (aggregated snapshots; comment theme examples are already redacted).
-- Data impact when this job runs in production: irreversible DELETE of old events/feedback only.
-- Rollback: SELECT cron.unschedule('paylens-retention-cleanup'); DROP FUNCTION IF EXISTS paylens_delete_expired_rows();
-- Do not execute this migration from verify scripts (PGlite has no pg_cron). Apply only on Postgres/Supabase.

CREATE OR REPLACE FUNCTION paylens_delete_expired_rows()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM events e
  USING projects p
  WHERE e.project_id = p.id
    AND e.occurred_at < (now() - make_interval(days => p.retention_days));

  DELETE FROM feedback f
  USING projects p
  WHERE f.project_id = p.id
    AND f.occurred_at < (now() - make_interval(days => p.retention_days));
END;
$$;
--> statement-breakpoint
SELECT cron.schedule(
  'paylens-retention-cleanup',
  '15 3 * * *',
  $$SELECT paylens_delete_expired_rows();$$
);
