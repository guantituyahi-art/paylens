import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { eachDate, formatLocalDate, type Period } from "@/lib/period";
import { countSessionFeedback } from "@/lib/feedback-stats";
import { getIngestionHealth } from "@/lib/ingestion-health";

/** 关闭后仍把 purchase_success 算进同一次 Paywall 的时间窗。 */
export const PURCHASE_WINDOW_MINUTES = 10;

export const DROP_LABELS = {
  view_to_click: "Paywall → 点击订阅",
  click_to_purchase: "点击订阅 → 购买成功",
} as const;

export type DropStep = keyof typeof DROP_LABELS;

export type Overview = {
  timezone: string;
  period: Period;
  funnel: {
    sessions: number;
    clicked: number;
    purchased: number;
    view_to_click: number | null;
    click_to_purchase: number | null;
    overall: number | null;
  };
  biggest_drop: { step: DropStep; lost: number; lost_rate: number | null } | null;
  closed_without_purchase: number;
  feedback_count: number;
  feedback_response_rate: number | null;
  daily: Array<{
    date: string;
    sessions: number;
    purchased: number;
    overall: number | null;
    partial: boolean;
  }>;
  health: {
    last_event_at: string | null;
    event_names_seen: string[];
    orphan_sessions: number;
  };
};

export type FilterOptions = {
  app_versions: string[];
  paywall_versions: string[];
};

type OverviewInput = {
  period: Period;
  now: Date;
  appVersion: string | null;
  paywallVersion: string | null;
};

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
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

function textCell(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * 漏斗按 paywall session 计，不按用户、不按事件条数。
 * 一个 session 归到它最早一条 paywall_viewed 的项目本地自然日。
 * 版本筛选也只看这条 paywall_viewed。
 * purchased：没有 paywall_closed，或购买时间不晚于最早关闭时间 + 10 分钟。
 * 没有 paywall_viewed 的事件不进这里，只出现在接入健康的孤儿 session 里。
 */
export async function getOverview(
  db: Database,
  project: { id: string; timezone: string },
  input: OverviewInput,
): Promise<Overview> {
  const { from, to } = input.period;
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
      SELECT *
      FROM viewed
      WHERE to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') >= ${from}
        AND to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') <= ${to}
        ${input.appVersion ? sql`AND app_version = ${input.appVersion}` : sql``}
        ${input.paywallVersion ? sql`AND paywall_version = ${input.paywallVersion}` : sql``}
    ),
    agg AS (
      SELECT
        anchored.paywall_session_id,
        anchored.viewed_at,
        bool_or(e.event_name = 'subscribe_clicked') AS has_click,
        min(e.occurred_at) FILTER (WHERE e.event_name = 'paywall_closed') AS closed_at
      FROM anchored
      JOIN events e
        ON e.project_id = ${project.id}
       AND e.paywall_session_id = anchored.paywall_session_id
      GROUP BY anchored.paywall_session_id, anchored.viewed_at
    ),
    classified AS (
      SELECT
        to_char(agg.viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') AS day,
        agg.has_click,
        agg.closed_at IS NOT NULL AS has_close,
        EXISTS (
          SELECT 1
          FROM events purchase
          WHERE purchase.project_id = ${project.id}
            AND purchase.paywall_session_id = agg.paywall_session_id
            AND purchase.event_name = 'purchase_success'
            AND purchase.occurred_at <= COALESCE(agg.closed_at, purchase.occurred_at)
              + (${PURCHASE_WINDOW_MINUTES} * interval '1 minute')
        ) AS has_purchase
      FROM agg
    )
    SELECT
      day,
      count(*)::int AS sessions,
      count(*) FILTER (WHERE has_click)::int AS clicked,
      count(*) FILTER (WHERE has_purchase)::int AS purchased,
      count(*) FILTER (WHERE has_close AND NOT has_purchase)::int AS closed_without_purchase
    FROM classified
    GROUP BY day
    ORDER BY day
  `);

  const today = formatLocalDate(input.now, project.timezone);
  const byDay = new Map<string, { sessions: number; clicked: number; purchased: number; closedWithoutPurchase: number }>();
  for (const row of queryRows(result)) {
    byDay.set(textCell(row.day), {
      sessions: Number(row.sessions ?? 0),
      clicked: Number(row.clicked ?? 0),
      purchased: Number(row.purchased ?? 0),
      closedWithoutPurchase: Number(row.closed_without_purchase ?? 0),
    });
  }

  let sessions = 0;
  let clicked = 0;
  let purchased = 0;
  let closedWithoutPurchase = 0;
  const daily = eachDate(from, to).map((date) => {
    const row = byDay.get(date) ?? { sessions: 0, clicked: 0, purchased: 0, closedWithoutPurchase: 0 };
    sessions += row.sessions;
    clicked += row.clicked;
    purchased += row.purchased;
    closedWithoutPurchase += row.closedWithoutPurchase;
    return {
      date,
      sessions: row.sessions,
      purchased: row.purchased,
      overall: rate(row.purchased, row.sessions),
      partial: date === today,
    };
  });

  const viewLost = sessions - clicked;
  const clickLost = clicked - purchased;
  // 两步流失一样多时，算更前面的那一步（看到 → 点击）。
  const biggestDrop =
    sessions === 0
      ? null
      : viewLost >= clickLost
        ? { step: "view_to_click" as const, lost: viewLost, lost_rate: rate(viewLost, sessions) }
        : { step: "click_to_purchase" as const, lost: clickLost, lost_rate: rate(clickLost, clicked) };

  const health = await getIngestionHealth(db, project.id);
  const feedbackCount = await countSessionFeedback(db, project, {
    period: input.period,
    appVersion: input.appVersion,
    paywallVersion: input.paywallVersion,
  });

  return {
    timezone: project.timezone,
    period: input.period,
    funnel: {
      sessions,
      clicked,
      purchased,
      view_to_click: rate(clicked, sessions),
      click_to_purchase: rate(purchased, clicked),
      overall: rate(purchased, sessions),
    },
    biggest_drop: biggestDrop,
    closed_without_purchase: closedWithoutPurchase,
    feedback_count: feedbackCount,
    feedback_response_rate: rate(feedbackCount, closedWithoutPurchase),
    daily,
    health: {
      last_event_at: health.lastEventAt,
      event_names_seen: health.eventNamesSeen,
      orphan_sessions: health.orphanSessions,
    },
  };
}

export async function getFilterOptions(
  db: Database,
  project: { id: string; timezone: string },
  period: Period,
): Promise<FilterOptions> {
  const result = await db.execute(sql`
    WITH viewed AS (
      SELECT DISTINCT ON (paywall_session_id)
        occurred_at AS viewed_at,
        app_version,
        paywall_version
      FROM events
      WHERE project_id = ${project.id}
        AND event_name = 'paywall_viewed'
      ORDER BY paywall_session_id, occurred_at ASC, id ASC
    )
    SELECT DISTINCT app_version, paywall_version
    FROM viewed
    WHERE to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') >= ${period.from}
      AND to_char(viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') <= ${period.to}
  `);

  const appVersions = new Set<string>();
  const paywallVersions = new Set<string>();
  for (const row of queryRows(result)) {
    const appVersion = textCell(row.app_version).trim();
    const paywallVersion = textCell(row.paywall_version).trim();
    if (appVersion) appVersions.add(appVersion);
    if (paywallVersion) paywallVersions.add(paywallVersion);
  }

  return {
    app_versions: [...appVersions].sort((a, b) => a.localeCompare(b)),
    paywall_versions: [...paywallVersions].sort((a, b) => a.localeCompare(b)),
  };
}
