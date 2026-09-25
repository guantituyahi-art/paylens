import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { events, projects } from "@/db/schema";
import { anchorCte, type MetricScope } from "@/lib/metrics/anchor";
import { makeEnvelope, type Envelope } from "@/lib/metrics/envelope";
import { intCell, queryRows, textCell } from "@/lib/metrics/rows";
import { EVENT_NAMES } from "@/lib/ingest-events";
import { MIN_FEEDBACK, MIN_REASON_COUNT, MIN_SESSIONS } from "@/lib/thresholds";

export type IngestionHealthResult = {
  total_events: number;
  last_event_at: string | null;
  event_names_seen: string[];
  orphan_sessions: number;
  sdk_versions: Array<{ version: string; count: number }>;
  rejections: { recorded: false; count: null };
};

export async function getIngestionHealth(
  db: Database,
  project: { id: string; timezone: string },
  asOf: Date,
): Promise<Envelope<IngestionHealthResult>> {
  const receivedBy = sql`${events.receivedAt} <= ${asOf.toISOString()}::timestamptz`;
  const [summary] = await db
    .select({
      totalEvents: sql<number>`count(*)::int`,
      lastEventAt: sql<Date | null>`max(${events.receivedAt})`,
    })
    .from(events)
    .where(and(eq(events.projectId, project.id), receivedBy));
  const names = await db
    .selectDistinct({ eventName: events.eventName })
    .from(events)
    .where(and(eq(events.projectId, project.id), receivedBy));
  const [orphans] = await db
    .select({
      orphanSessions: sql<number>`count(distinct ${events.paywallSessionId})::int`,
    })
    .from(events)
    .where(
      sql`${events.projectId} = ${project.id}
        AND ${events.receivedAt} <= ${asOf.toISOString()}::timestamptz
        and not exists (
        select 1 from events viewed
        where viewed.project_id = ${project.id}
          and viewed.paywall_session_id = ${events.paywallSessionId}
          and viewed.event_name = 'paywall_viewed'
          and viewed.received_at <= ${asOf.toISOString()}::timestamptz
      )`,
    );
  const versions = await db.execute(sql`
    SELECT coalesce(nullif(sdk_version, ''), '（未上报）') AS version, count(*)::int AS count
    FROM events
    WHERE project_id = ${project.id}
      AND received_at <= ${asOf.toISOString()}::timestamptz
    GROUP BY 1
    ORDER BY count DESC, version
  `);
  const seen = new Set(names.map((row) => row.eventName));
  const result: IngestionHealthResult = {
    total_events: Number(summary?.totalEvents ?? 0),
    last_event_at: summary?.lastEventAt ? new Date(summary.lastEventAt).toISOString() : null,
    event_names_seen: EVENT_NAMES.filter((name) => seen.has(name)),
    orphan_sessions: Number(orphans?.orphanSessions ?? 0),
    sdk_versions: queryRows(versions).map((row) => ({ version: textCell(row.version), count: intCell(row.count) })),
    rejections: { recorded: false, count: null },
  };
  return makeEnvelope({
    tool: "get_ingestion_health",
    args: {},
    timezone: project.timezone,
    asOf,
    dataThrough: result.last_event_at ?? asOf.toISOString(),
    definitions: {
      orphan: "没有 paywall_viewed 的会话只记在接入健康里，不进漏斗。",
      rejections: "拒收没有单独落库，这里不提供拒收次数。",
    },
    sample: { unit: "paywall_session", n: result.total_events, required: 0, status: "ok" },
    result,
    facts: [],
    caveats: ["接入健康看整个项目，不随日期和版本筛选变化。拒收次数目前没有保存。"],
  });
}

export type ProjectContextResult = {
  timezone: string;
  thresholds: { min_sessions: number; min_feedback: number; min_reason_count: number };
  events: { exists: boolean; from: string | null; to: string | null; count: number };
  feedback: { exists: boolean; from: string | null; to: string | null; count: number };
  event_names_seen: string[];
};

export async function getProjectContext(
  db: Database,
  project: { id: string; timezone: string },
  asOf: Date,
): Promise<Envelope<ProjectContextResult>> {
  const eventSpan = await db.execute(sql`
    SELECT count(*)::int AS count,
           min(occurred_at) AS first_at,
           max(occurred_at) AS last_at
    FROM events
    WHERE project_id = ${project.id}
      AND received_at <= ${asOf.toISOString()}::timestamptz
  `);
  const feedbackSpan = await db.execute(sql`
    SELECT count(*)::int AS count,
           min(occurred_at) AS first_at,
           max(occurred_at) AS last_at
    FROM feedback
    WHERE project_id = ${project.id}
      AND received_at <= ${asOf.toISOString()}::timestamptz
  `);
  const names = await db
    .selectDistinct({ eventName: events.eventName })
    .from(events)
    .where(and(eq(events.projectId, project.id), sql`${events.receivedAt} <= ${asOf.toISOString()}::timestamptz`));
  const eventRow = queryRows(eventSpan)[0] ?? {};
  const feedbackRow = queryRows(feedbackSpan)[0] ?? {};
  const eventCount = intCell(eventRow.count);
  const feedbackCount = intCell(feedbackRow.count);
  const seen = new Set(names.map((row) => row.eventName));
  return makeEnvelope({
    tool: "get_project_context",
    args: {},
    timezone: project.timezone,
    asOf,
    dataThrough: asOf.toISOString(),
    definitions: {
      coverage: "起止时间是已入库事件的 occurred_at，按数据库里的时刻，不是按筛选后的本地日。",
    },
    sample: { unit: "paywall_session", n: eventCount, required: 0, status: "ok" },
    result: {
      timezone: project.timezone,
      thresholds: { min_sessions: MIN_SESSIONS, min_feedback: MIN_FEEDBACK, min_reason_count: MIN_REASON_COUNT },
      events: { exists: eventCount > 0, from: isoOrNull(eventRow.first_at), to: isoOrNull(eventRow.last_at), count: eventCount },
      feedback: {
        exists: feedbackCount > 0,
        from: isoOrNull(feedbackRow.first_at),
        to: isoOrNull(feedbackRow.last_at),
        count: feedbackCount,
      },
      event_names_seen: EVENT_NAMES.filter((name) => seen.has(name)),
    },
    facts: [],
    caveats: ["门槛只挡住 AI 假设，不挡住概览上的次数和比率。"],
  });
}

export type DimensionName = "platform" | "app_version" | "paywall_version" | "product_id";

export type DimensionValue = { value: string; first_seen: string; last_seen: string };

export async function listDimensionValues(
  db: Database,
  project: { id: string; timezone: string },
  input: { dimension: DimensionName; scope: MetricScope; asOf: Date },
): Promise<Envelope<{ dimension: DimensionName; values: DimensionValue[] }> | { error: "unsupported_dimension"; message: string }> {
  const column =
    input.dimension === "platform"
      ? sql`anchored.platform`
      : input.dimension === "app_version"
        ? sql`anchored.app_version`
        : input.dimension === "paywall_version"
          ? sql`anchored.paywall_version`
          : null;
  const result =
    column === null
      ? await db.execute(sql`
          WITH ${anchorCte(project, input.scope)}
          SELECT events.product_id AS value,
                 min(events.occurred_at) AS first_seen,
                 max(events.occurred_at) AS last_seen
          FROM events
          JOIN anchored ON anchored.paywall_session_id = events.paywall_session_id
          WHERE events.project_id = ${project.id}
            AND events.event_name IN ('subscribe_clicked', 'purchase_success', 'purchase_failed')
            AND events.product_id IS NOT NULL
            ${input.scope.asOf ? sql`AND events.received_at <= ${input.scope.asOf.toISOString()}::timestamptz` : sql``}
          GROUP BY events.product_id
          ORDER BY value
        `)
      : await db.execute(sql`
          WITH ${anchorCte(project, input.scope)}
          SELECT ${column} AS value,
                 min(anchored.viewed_at) AS first_seen,
                 max(anchored.viewed_at) AS last_seen
          FROM anchored
          WHERE ${column} IS NOT NULL AND btrim(${column}::text) <> ''
          GROUP BY ${column}
          ORDER BY value
        `);
  const values = queryRows(result)
    .map((row) => ({
      value: textCell(row.value).trim(),
      first_seen: isoOrNull(row.first_seen) ?? "",
      last_seen: isoOrNull(row.last_seen) ?? "",
    }))
    .filter((row) => row.value);
  return makeEnvelope({
    tool: "list_dimension_values",
    args: { dimension: input.dimension, period: input.scope.period, platform: input.scope.platform, app_version: input.scope.appVersion, paywall_version: input.scope.paywallVersion },
    timezone: project.timezone,
    asOf: input.asOf,
    dataThrough: input.scope.asOf?.toISOString() ?? input.asOf.toISOString(),
    definitions: { value: "取值来自本期最早一条 paywall_viewed。product_id 只来自点击、购买和支付失败。" },
    sample: { unit: "paywall_session", n: values.length, required: 0, status: "ok" },
    result: { dimension: input.dimension, values },
    facts: [],
    caveats: [],
  });
}

export async function projectTimezone(db: Database, projectId: string) {
  const [project] = await db
    .select({ timezone: projects.timezone })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return project?.timezone ?? "UTC";
}

function isoOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
