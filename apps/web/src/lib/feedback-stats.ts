import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { anchorCte, type MetricScope, type Platform } from "@/lib/metrics/anchor";
import { getFeedbackReasons, loadReasonCounts } from "@/lib/metrics/feedback";
import type { Period } from "@/lib/period";
import { MIN_REASON_COUNT } from "@/lib/thresholds";

export { MIN_REASON_COUNT };
export const COMMENT_PAGE_SIZE = 50;

export type ReasonStat = {
  code: string;
  label: string;
  count: number;
  share: number;
  prev_count: number;
  prev_share: number | null;
  delta_pp: number | null;
  low_sample: boolean;
};

export type FeedbackSummary = {
  total: number;
  previous_total: number;
  compare: Period;
  reasons: ReasonStat[];
};

export type FeedbackComment = {
  id: number;
  reason_code: string;
  reason_label: string | null;
  comment: string | null;
  app_version: string;
  paywall_version: string | null;
  occurred_at: string;
  orphan: boolean;
};

type VersionFilter = {
  period: Period;
  appVersion: string | null;
  paywallVersion: string | null;
  platform?: Platform | null;
  asOf?: Date | null;
};

function queryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) {
    return result.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  return [];
}

function textCell(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function versionSql(input: VersionFilter) {
  return sql`
    ${input.platform ? sql`AND platform = ${input.platform}` : sql``}
    ${input.appVersion ? sql`AND app_version = ${input.appVersion}` : sql``}
    ${input.paywallVersion ? sql`AND paywall_version = ${input.paywallVersion}` : sql``}
    ${input.asOf ? sql`AND received_at <= ${input.asOf.toISOString()}::timestamptz` : sql``}
  `;
}

function scopeOf(input: VersionFilter) {
  return {
    period: input.period,
    platform: input.platform ?? null,
    appVersion: input.appVersion,
    paywallVersion: input.paywallVersion,
    asOf: input.asOf ?? null,
  };
}

function reasonScope(input: VersionFilter): MetricScope {
  return scopeOf(input);
}

/** 只统计挂在本期 Paywall session 上的反馈。没有 paywall_viewed 的不计入回答率。 */
export async function countSessionFeedback(
  db: Database,
  project: { id: string; timezone: string },
  input: VersionFilter,
) {
  const counts = await loadReasonCounts(db, project, reasonScope(input));
  let total = 0;
  for (const row of counts.values()) total += row.count;
  return total;
}

export async function getFeedbackSummary(
  db: Database,
  project: { id: string; timezone: string },
  input: VersionFilter,
): Promise<FeedbackSummary> {
  const envelope = await getFeedbackReasons(db, project, reasonScope(input), input.asOf ?? new Date());
  return {
    total: envelope.result.total,
    previous_total: envelope.result.previous_total,
    compare: envelope.result.compare,
    reasons: envelope.result.reasons,
  };
}

function encodeCursor(occurredAt: string, id: number) {
  return Buffer.from(`${occurredAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { occurredAt: string; id: number } | null {
  try {
    const text = Buffer.from(cursor, "base64url").toString("utf8");
    const splitAt = text.lastIndexOf("|");
    if (splitAt <= 0) return null;
    const occurredAt = text.slice(0, splitAt);
    const id = Number(text.slice(splitAt + 1));
    if (!Number.isInteger(id) || id < 1 || Number.isNaN(new Date(occurredAt).getTime())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

export async function getFeedbackComments(
  db: Database,
  project: { id: string; timezone: string },
  input: VersionFilter & { textOnly: boolean; cursor: string | null; pageSize?: number },
): Promise<{ comments: FeedbackComment[]; next_cursor: string | null } | { error: "invalid_cursor" }> {
  const decoded = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && !decoded) return { error: "invalid_cursor" };
  const pageSize = input.pageSize ?? COMMENT_PAGE_SIZE;
  const result = await db.execute(sql`
    SELECT
      id,
      reason_code,
      reason_label,
      comment,
      app_version,
      paywall_version,
      occurred_at,
      NOT EXISTS (
        SELECT 1 FROM events viewed
        WHERE viewed.project_id = feedback.project_id
          AND viewed.paywall_session_id = feedback.paywall_session_id
          AND viewed.event_name = 'paywall_viewed'
      ) AS orphan
    FROM feedback
    WHERE project_id = ${project.id}
      AND occurred_at >= ((${input.period.from} || ' 00:00:00')::timestamp AT TIME ZONE ${project.timezone})
      AND occurred_at < (((${input.period.to} || ' 00:00:00')::timestamp + interval '1 day') AT TIME ZONE ${project.timezone})
      ${versionSql(input)}
      ${input.textOnly ? sql`AND comment IS NOT NULL AND comment <> ''` : sql``}
      ${
        decoded
          ? sql`AND (
              occurred_at < ${decoded.occurredAt}::timestamptz
              OR (occurred_at = ${decoded.occurredAt}::timestamptz AND id < ${decoded.id})
            )`
          : sql``
      }
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${pageSize + 1}
  `);
  const rows = queryRows(result);
  const page = rows.slice(0, pageSize);
  const comments = page.map((row) => {
    const occurredAt = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : textCell(row.occurred_at);
    return {
      id: Number(row.id),
      reason_code: textCell(row.reason_code),
      reason_label: textCell(row.reason_label) || null,
      comment: textCell(row.comment) || null,
      app_version: textCell(row.app_version),
      paywall_version: textCell(row.paywall_version) || null,
      occurred_at: new Date(occurredAt).toISOString(),
      orphan: row.orphan === true || row.orphan === "t" || row.orphan === "true",
    };
  });
  const last = comments[comments.length - 1];
  return {
    comments,
    next_cursor: rows.length > pageSize && last ? encodeCursor(last.occurred_at, last.id) : null,
  };
}
