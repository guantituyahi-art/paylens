import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { getFeedbackSummary } from "@/lib/feedback-stats";
import { getOverview, PURCHASE_WINDOW_MINUTES } from "@/lib/funnel";
import { previousPeriod, type Period } from "@/lib/period";
import type { ReportSnapshot } from "@/lib/report-facts";
import { MAX_THEME_COMMENTS, MIN_FEEDBACK, MIN_REASON_COUNT, MIN_SESSIONS } from "@/lib/thresholds";

export type ThemeComment = { id: string; text: string };

type MeasuredSnapshot = Omit<ReportSnapshot, "facts" | "key_changes" | "caveats" | "comment_themes"> & {
  comments: ThemeComment[];
};

function inclusiveDays(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

function versionSql(appVersion: string | null, paywallVersion: string | null) {
  return sql`
    ${appVersion ? sql`AND app_version = ${appVersion}` : sql``}
    ${paywallVersion ? sql`AND paywall_version = ${paywallVersion}` : sql``}
  `;
}

function queryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) {
    return result.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  return [];
}

function funnelCounts(overview: Awaited<ReturnType<typeof getOverview>>) {
  return {
    sessions: overview.funnel.sessions,
    clicked: overview.funnel.clicked,
    purchased: overview.funnel.purchased,
    view_to_click: overview.funnel.view_to_click,
    click_to_purchase: overview.funnel.click_to_purchase,
    overall: overview.funnel.overall,
  };
}

async function productCounts(
  db: Database,
  project: { id: string; timezone: string },
  period: Period,
  appVersion: string | null,
  paywallVersion: string | null,
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
      WHERE to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') >= ${period.from}
        AND to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') <= ${period.to}
        ${versionSql(appVersion, paywallVersion)}
    ),
    closed AS (
      SELECT anchored.paywall_session_id,
             min(events.occurred_at) FILTER (WHERE events.event_name = 'paywall_closed') AS closed_at
      FROM anchored
      JOIN events
        ON events.project_id = ${project.id}
       AND events.paywall_session_id = anchored.paywall_session_id
      GROUP BY anchored.paywall_session_id
    ),
    purchased_sessions AS (
      SELECT closed.paywall_session_id
      FROM closed
      WHERE EXISTS (
        SELECT 1 FROM events purchase
        WHERE purchase.project_id = ${project.id}
          AND purchase.paywall_session_id = closed.paywall_session_id
          AND purchase.event_name = 'purchase_success'
          AND purchase.occurred_at <= COALESCE(closed.closed_at, purchase.occurred_at)
            + (${PURCHASE_WINDOW_MINUTES} * interval '1 minute')
      )
    )
    SELECT
      events.product_id,
      count(DISTINCT events.paywall_session_id) FILTER (WHERE events.event_name = 'subscribe_clicked')::int AS clicked,
      count(DISTINCT events.paywall_session_id) FILTER (
        WHERE events.event_name = 'purchase_success'
          AND events.paywall_session_id IN (SELECT paywall_session_id FROM purchased_sessions)
      )::int AS purchased
    FROM events
    JOIN anchored ON anchored.paywall_session_id = events.paywall_session_id
    WHERE events.project_id = ${project.id}
      AND events.product_id IS NOT NULL
      AND events.event_name IN ('subscribe_clicked', 'purchase_success')
    GROUP BY events.product_id
    ORDER BY clicked DESC, events.product_id
  `);
  return queryRows(result)
    .map((row) => ({
      product_id: String(row.product_id ?? ""),
      clicked: Number(row.clicked ?? 0),
      purchased: Number(row.purchased ?? 0),
    }))
    .filter((row) => row.product_id);
}

async function themeComments(
  db: Database,
  project: { id: string; timezone: string },
  period: Period,
  appVersion: string | null,
  paywallVersion: string | null,
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
      WHERE to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') >= ${period.from}
        AND to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') <= ${period.to}
        ${versionSql(appVersion, paywallVersion)}
    )
    SELECT feedback.id, feedback.comment
    FROM feedback
    JOIN anchored ON anchored.paywall_session_id = feedback.paywall_session_id
    WHERE feedback.project_id = ${project.id}
      AND feedback.comment IS NOT NULL
      AND feedback.comment <> ''
    ORDER BY feedback.occurred_at DESC, feedback.id DESC
    LIMIT ${MAX_THEME_COMMENTS}
  `);
  return queryRows(result).map((row) => ({
    id: String(row.id),
    text: String(row.comment ?? ""),
  }));
}

export async function buildMeasuredSnapshot(
  db: Database,
  project: { id: string; timezone: string },
  input: { period: Period; now: Date; appVersion: string | null; paywallVersion: string | null },
): Promise<MeasuredSnapshot> {
  const compare = previousPeriod(input.period);
  const filter = { appVersion: input.appVersion, paywallVersion: input.paywallVersion };
  const [current, previous, summary, products, comments] = await Promise.all([
    getOverview(db, project, { period: input.period, now: input.now, ...filter }),
    getOverview(db, project, { period: compare, now: input.now, ...filter }),
    getFeedbackSummary(db, project, { period: input.period, ...filter }),
    productCounts(db, project, input.period, input.appVersion, input.paywallVersion),
    themeComments(db, project, input.period, input.appVersion, input.paywallVersion),
  ]);
  return {
    timezone: project.timezone,
    period: { start: input.period.from, end: input.period.to, days: inclusiveDays(input.period.from, input.period.to) },
    compare: { start: compare.from, end: compare.to },
    filters: { app_version: input.appVersion, paywall_version: input.paywallVersion },
    thresholds: {
      min_sessions: MIN_SESSIONS,
      min_feedback: MIN_FEEDBACK,
      min_reason_count: MIN_REASON_COUNT,
      met: current.funnel.sessions >= MIN_SESSIONS && summary.total >= MIN_FEEDBACK,
    },
    funnel: {
      current: funnelCounts(current),
      previous: funnelCounts(previous),
      biggest_drop: current.biggest_drop,
    },
    feedback: {
      total: summary.total,
      closed_without_purchase: current.closed_without_purchase,
      response_rate: current.feedback_response_rate,
      reasons: summary.reasons,
    },
    by_product: products,
    comments,
  };
}
