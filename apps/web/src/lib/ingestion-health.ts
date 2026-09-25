import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { projects } from "@/db/schema";
import { getIngestionHealth as loadIngestionHealth, projectTimezone } from "@/lib/metrics/context";

export async function getOwnedProject(db: Database, projectId: string, developerId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.developerId, developerId)))
    .limit(1);
  return project ?? null;
}

export async function getIngestionHealth(db: Database, projectId: string, asOf = new Date()) {
  const timezone = await projectTimezone(db, projectId);
  const envelope = await loadIngestionHealth(db, { id: projectId, timezone }, asOf);
  return {
    totalEvents: envelope.result.total_events,
    lastEventAt: envelope.result.last_event_at,
    eventNamesSeen: envelope.result.event_names_seen,
    orphanSessions: envelope.result.orphan_sessions,
  };
}
