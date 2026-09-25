import type { Database } from "@/db/client";
import { eachDate, formatLocalDate, type Period } from "@/lib/period";
import { countSessionFeedback } from "@/lib/feedback-stats";
import { getIngestionHealth } from "@/lib/ingestion-health";
import type { Platform } from "@/lib/metrics/anchor";
import { listDimensionValues } from "@/lib/metrics/context";
import { loadFunnel, PURCHASE_WINDOW_MINUTES } from "@/lib/metrics/paywall";

export { PURCHASE_WINDOW_MINUTES };

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
    failure_rate: number | null;
  };
  payment_error: number;
  user_cancelled: number;
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
  platforms: string[];
  app_versions: string[];
  paywall_versions: string[];
};

type OverviewInput = {
  period: Period;
  now: Date;
  appVersion: string | null;
  paywallVersion: string | null;
  platform?: Platform | null;
  asOf?: Date | null;
};

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
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
  const funnel = await loadFunnel(db, project, {
    period: input.period,
    platform: input.platform ?? null,
    appVersion: input.appVersion,
    paywallVersion: input.paywallVersion,
    asOf: input.asOf ?? null,
  });

  const today = formatLocalDate(input.now, project.timezone);
  const byDay = new Map(funnel.daily.map((day) => [day.day, day]));

  let sessions = 0;
  let clicked = 0;
  let purchased = 0;
  let closedWithoutPurchase = 0;
  const daily = eachDate(from, to).map((date) => {
    const row = byDay.get(date) ?? {
      sessions: 0,
      clicked: 0,
      purchased: 0,
      closedWithoutPurchase: 0,
      paymentError: 0,
      userCancelled: 0,
    };
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
    platform: input.platform ?? null,
    asOf: input.asOf ?? null,
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
      failure_rate: rate(funnel.payment_error, clicked),
    },
    payment_error: funnel.payment_error,
    user_cancelled: funnel.user_cancelled,
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
  const scope = { period, platform: null, appVersion: null, paywallVersion: null, asOf: null };
  const asOf = new Date();
  const [platforms, appVersions, paywallVersions] = await Promise.all([
    listDimensionValues(db, project, { dimension: "platform", scope, asOf }),
    listDimensionValues(db, project, { dimension: "app_version", scope, asOf }),
    listDimensionValues(db, project, { dimension: "paywall_version", scope, asOf }),
  ]);
  const names = (value: typeof platforms) =>
    "error" in value ? [] : value.result.values.map((item) => item.value).sort((a, b) => a.localeCompare(b));
  return {
    platforms: names(platforms),
    app_versions: names(appVersions),
    paywall_versions: names(paywallVersions),
  };
}
