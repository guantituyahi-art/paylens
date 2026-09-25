import { sql } from "drizzle-orm";
import type { Period } from "@/lib/period";

export type Platform = "ios" | "android";

export type MetricScope = {
  period: Period;
  platform: Platform | null;
  appVersion: string | null;
  paywallVersion: string | null;
  asOf: Date | null;
};

export function emptyScope(period: Period): MetricScope {
  return { period, platform: null, appVersion: null, paywallVersion: null, asOf: null };
}

/** 本地自然日的起点和次日起点，用 UTC 比较，结果与 to_char(时区) 的日期一致。 */
export function anchorCte(project: { id: string; timezone: string }, scope: MetricScope) {
  return sql`
    viewed AS (
      SELECT DISTINCT ON (paywall_session_id)
        paywall_session_id,
        occurred_at AS viewed_at,
        platform,
        app_version,
        paywall_version
      FROM events
      WHERE project_id = ${project.id}
        AND event_name = 'paywall_viewed'
        ${scope.asOf ? sql`AND received_at <= ${scope.asOf.toISOString()}::timestamptz` : sql``}
      ORDER BY paywall_session_id, occurred_at ASC, id ASC
    ),
    anchored AS (
      SELECT *
      FROM viewed
      WHERE viewed_at >= ((${scope.period.from} || ' 00:00:00')::timestamp AT TIME ZONE ${project.timezone})
        AND viewed_at < (((${scope.period.to} || ' 00:00:00')::timestamp + interval '1 day') AT TIME ZONE ${project.timezone})
        ${scope.platform ? sql`AND platform = ${scope.platform}` : sql``}
        ${scope.appVersion ? sql`AND app_version = ${scope.appVersion}` : sql``}
        ${scope.paywallVersion ? sql`AND paywall_version = ${scope.paywallVersion}` : sql``}
    )
  `;
}

export function eventAsOf(alias: string, asOf: Date | null) {
  if (!asOf) return sql``;
  if (alias === "e") return sql`AND e.received_at <= ${asOf.toISOString()}::timestamptz`;
  if (alias === "purchase") return sql`AND purchase.received_at <= ${asOf.toISOString()}::timestamptz`;
  if (alias === "events") return sql`AND events.received_at <= ${asOf.toISOString()}::timestamptz`;
  if (alias === "closed") return sql`AND closed.received_at <= ${asOf.toISOString()}::timestamptz`;
  if (alias === "fail") return sql`AND fail.received_at <= ${asOf.toISOString()}::timestamptz`;
  return sql``;
}
