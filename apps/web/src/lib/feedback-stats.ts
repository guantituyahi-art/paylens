import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { previousPeriod, type Period } from "@/lib/period";
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

function versionSql(appVersion: string | null, paywallVersion: string | null) {
  return sql`
    ${appVersion ? sql`AND app_version = ${appVersion}` : sql``}
    ${paywallVersion ? sql`AND paywall_version = ${paywallVersion}` : sql``}
  `;
}

async function reasonCounts(
  db: Database,
  project: { id: string; timezone: string },
  input: VersionFilter,
) {
  const result = await db.execute(sql`
    WITH viewed AS (
      SELECT DISTINCT ON (paywall_session_id)
        paywall_session_id,
        occurred_at AS viewed_at,
        app_version,
        paywall_version
      FROM events
      WHERE project_id = ${project.id}
        AND event_name = 'paywall_viewed'
      ORDER BY paywall_session_id, occurred_at ASC, id ASC
    ),
    anchored AS (
      SELECT paywall_session_id
      FROM viewed
      WHERE to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') >= ${input.period.from}
        AND to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') <= ${input.period.to}
        ${versionSql(input.appVersion, input.paywallVersion)}
    )
    SELECT
      feedback.reason_code AS code,
      count(*)::int AS count,
      (
        array_agg(feedback.reason_label ORDER BY feedback.occurred_at DESC)
        FILTER (WHERE feedback.reason_label IS NOT NULL)
      )[1] AS label
    FROM feedback
    JOIN anchored ON anchored.paywall_session_id = feedback.paywall_session_id
    WHERE feedback.project_id = ${project.id}
    GROUP BY feedback.reason_code
  `);
  const counts = new Map<string, { count: number; label: string }>();
  for (const row of queryRows(result)) {
    const code = textCell(row.code);
    if (!code) continue;
    counts.set(code, { count: Number(row.count ?? 0), label: textCell(row.label) });
  }
  return counts;
}

/** 只统计挂在本期 Paywall session 上的反馈。没有 paywall_viewed 的不计入回答率。 */
export async function countSessionFeedback(
  db: Database,
  project: { id: string; timezone: string },
  input: VersionFilter,
) {
  const counts = await reasonCounts(db, project, input);
  let total = 0;
  for (const row of counts.values()) total += row.count;
  return total;
}

export async function getFeedbackSummary(
  db: Database,
  project: { id: string; timezone: string },
  input: VersionFilter,
): Promise<FeedbackSummary> {
  const compare = previousPeriod(input.period);
  const [current, previous] = await Promise.all([
    reasonCounts(db, project, input),
    reasonCounts(db, project, { ...input, period: compare }),
  ]);
  let total = 0;
  let previousTotal = 0;
  for (const row of current.values()) total += row.count;
  for (const row of previous.values()) previousTotal += row.count;

  const reasons = [...current.entries()]
    .map(([code, row]) => {
      const prevCount = previous.get(code)?.count ?? 0;
      const share = total === 0 ? 0 : row.count / total;
      const prevShare = previousTotal === 0 ? null : prevCount / previousTotal;
      return {
        code,
        label: row.label || code,
        count: row.count,
        share,
        prev_count: prevCount,
        prev_share: prevShare,
        delta_pp: prevShare === null ? null : Math.round((share - prevShare) * 100),
        low_sample: row.count < MIN_REASON_COUNT || prevCount < MIN_REASON_COUNT,
      };
    })
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return { total, previous_total: previousTotal, compare, reasons };
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
      AND to_char(occurred_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') >= ${input.period.from}
      AND to_char(occurred_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') <= ${input.period.to}
      ${versionSql(input.appVersion, input.paywallVersion)}
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
