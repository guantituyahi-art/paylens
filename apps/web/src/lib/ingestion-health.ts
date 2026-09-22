import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { events, projects } from "@/db/schema";
import { EVENT_NAMES } from "@/lib/ingest-events";

export async function getOwnedProject(db: Database, projectId: string, developerId: string) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.developerId, developerId)))
    .limit(1);
  return project ?? null;
}

export async function getIngestionHealth(db: Database, projectId: string) {
  const [summary] = await db
    .select({
      totalEvents: sql<number>`count(*)::int`,
      lastEventAt: sql<Date | null>`max(${events.receivedAt})`,
    })
    .from(events)
    .where(eq(events.projectId, projectId));

  const names = await db
    .selectDistinct({ eventName: events.eventName })
    .from(events)
    .where(eq(events.projectId, projectId));

  const [orphans] = await db
    .select({
      orphanSessions: sql<number>`count(distinct ${events.paywallSessionId})::int`,
    })
    .from(events)
    .where(
      and(
        eq(events.projectId, projectId),
        sql`not exists (
          select 1 from events viewed
          where viewed.project_id = ${projectId}
            and viewed.paywall_session_id = ${events.paywallSessionId}
            and viewed.event_name = 'paywall_viewed'
        )`,
      ),
    );

  const seen = new Set(names.map((row) => row.eventName));
  return {
    totalEvents: Number(summary?.totalEvents ?? 0),
    lastEventAt: summary?.lastEventAt ? new Date(summary.lastEventAt).toISOString() : null,
    eventNamesSeen: EVENT_NAMES.filter((name) => seen.has(name)),
    orphanSessions: Number(orphans?.orphanSessions ?? 0),
  };
}
