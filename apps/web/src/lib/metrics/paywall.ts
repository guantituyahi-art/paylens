import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { previousPeriod, type Period } from "@/lib/period";
import { MIN_SESSIONS } from "@/lib/thresholds";
import { anchorCte, eventAsOf, type MetricScope, type Platform } from "@/lib/metrics/anchor";
import { groupContribution, sumContributions } from "@/lib/metrics/contribution";
import { makeEnvelope, sampleStatus, type Envelope } from "@/lib/metrics/envelope";
import { intCell, queryRows, textCell } from "@/lib/metrics/rows";
import { compareSignal, presentRate, type RateView, type Signal } from "@/lib/metrics/sample";

export const PURCHASE_WINDOW_MINUTES = 10;

export type FunnelMetric =
  | "paywall.overall_conversion"
  | "paywall.view_to_click"
  | "paywall.click_to_purchase"
  | "paywall.failure_rate";

export type CompareMetric = FunnelMetric | "feedback.response_rate";

export type BreakdownDimension = "platform" | "app_version" | "paywall_version" | "product_id";

export type DayFunnel = {
  day: string;
  sessions: number;
  clicked: number;
  purchased: number;
  closedWithoutPurchase: number;
  paymentError: number;
  userCancelled: number;
};

const FUNNEL_DEFINITIONS = {
  session: "一次 paywall_viewed 算一次展示，归到最早那条的本地自然日。",
  purchased: "购买成功，且不晚于最早关闭时间加 10 分钟。没关闭也可以算购买。",
  failure_rate: "有 payment_error 的展示数 / 有点击的展示数。user_cancelled 单独计数，不算失败，也不算购买。",
};

type SessionCounts = {
  key: string;
  sessions: number;
  clicked: number;
  purchased: number;
  paymentError: number;
};

function metricParts(metric: FunnelMetric, row: SessionCounts) {
  if (metric === "paywall.view_to_click") return { numerator: row.clicked, denominator: row.sessions };
  if (metric === "paywall.click_to_purchase") return { numerator: row.purchased, denominator: row.clicked };
  if (metric === "paywall.failure_rate") return { numerator: row.paymentError, denominator: row.clicked };
  return { numerator: row.purchased, denominator: row.sessions };
}

export async function queryDailyFunnel(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
): Promise<DayFunnel[]> {
  const result = await db.execute(sql`
    WITH ${anchorCte(project, scope)},
    agg AS (
      SELECT
        anchored.paywall_session_id,
        anchored.viewed_at,
        bool_or(e.event_name = 'subscribe_clicked') AS has_click,
        bool_or(e.event_name = 'purchase_failed' AND e.failure_kind = 'payment_error') AS has_payment_error,
        bool_or(e.event_name = 'purchase_failed' AND e.failure_kind = 'user_cancelled') AS has_user_cancelled,
        min(e.occurred_at) FILTER (WHERE e.event_name = 'paywall_closed') AS closed_at
      FROM anchored
      JOIN events e
        ON e.project_id = ${project.id}
       AND e.paywall_session_id = anchored.paywall_session_id
       ${eventAsOf("e", scope.asOf)}
      GROUP BY anchored.paywall_session_id, anchored.viewed_at
    ),
    classified AS (
      SELECT
        to_char(agg.viewed_at AT TIME ZONE ${project.timezone}, 'YYYY-MM-DD') AS day,
        agg.has_click,
        agg.has_payment_error,
        agg.has_user_cancelled,
        agg.closed_at IS NOT NULL AS has_close,
        EXISTS (
          SELECT 1
          FROM events purchase
          WHERE purchase.project_id = ${project.id}
            AND purchase.paywall_session_id = agg.paywall_session_id
            AND purchase.event_name = 'purchase_success'
            ${eventAsOf("purchase", scope.asOf)}
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
      count(*) FILTER (WHERE has_close AND NOT has_purchase)::int AS closed_without_purchase,
      count(*) FILTER (WHERE has_payment_error)::int AS payment_error,
      count(*) FILTER (WHERE has_user_cancelled)::int AS user_cancelled
    FROM classified
    GROUP BY day
    ORDER BY day
  `);
  return queryRows(result).map((row) => ({
    day: textCell(row.day),
    sessions: intCell(row.sessions),
    clicked: intCell(row.clicked),
    purchased: intCell(row.purchased),
    closedWithoutPurchase: intCell(row.closed_without_purchase),
    paymentError: intCell(row.payment_error),
    userCancelled: intCell(row.user_cancelled),
  }));
}

async function querySessionGroups(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
  dimension: Exclude<BreakdownDimension, "product_id">,
): Promise<SessionCounts[]> {
  const column =
    dimension === "platform" ? sql`anchored.platform` : dimension === "app_version" ? sql`anchored.app_version` : sql`anchored.paywall_version`;
  const result = await db.execute(sql`
    WITH ${anchorCte(project, scope)},
    agg AS (
      SELECT
        ${column} AS group_key,
        anchored.paywall_session_id,
        bool_or(e.event_name = 'subscribe_clicked') AS has_click,
        bool_or(e.event_name = 'purchase_failed' AND e.failure_kind = 'payment_error') AS has_payment_error,
        min(e.occurred_at) FILTER (WHERE e.event_name = 'paywall_closed') AS closed_at
      FROM anchored
      JOIN events e
        ON e.project_id = ${project.id}
       AND e.paywall_session_id = anchored.paywall_session_id
       ${eventAsOf("e", scope.asOf)}
      GROUP BY group_key, anchored.paywall_session_id
    ),
    classified AS (
      SELECT
        agg.group_key,
        agg.has_click,
        agg.has_payment_error,
        EXISTS (
          SELECT 1
          FROM events purchase
          WHERE purchase.project_id = ${project.id}
            AND purchase.paywall_session_id = agg.paywall_session_id
            AND purchase.event_name = 'purchase_success'
            ${eventAsOf("purchase", scope.asOf)}
            AND purchase.occurred_at <= COALESCE(agg.closed_at, purchase.occurred_at)
              + (${PURCHASE_WINDOW_MINUTES} * interval '1 minute')
        ) AS has_purchase
      FROM agg
    )
    SELECT
      group_key,
      count(*)::int AS sessions,
      count(*) FILTER (WHERE has_click)::int AS clicked,
      count(*) FILTER (WHERE has_purchase)::int AS purchased,
      count(*) FILTER (WHERE has_payment_error)::int AS payment_error
    FROM classified
    GROUP BY group_key
  `);
  return queryRows(result).map((row) => ({
    key: textCell(row.group_key) || "（空）",
    sessions: intCell(row.sessions),
    clicked: intCell(row.clicked),
    purchased: intCell(row.purchased),
    paymentError: intCell(row.payment_error),
  }));
}

async function queryProductGroups(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
): Promise<SessionCounts[]> {
  const result = await db.execute(sql`
    WITH ${anchorCte(project, scope)},
    clicked AS (
      SELECT
        e.paywall_session_id,
        CASE
          WHEN count(DISTINCT e.product_id) FILTER (WHERE e.product_id IS NOT NULL) > 1 THEN '多个产品'
          WHEN count(DISTINCT e.product_id) FILTER (WHERE e.product_id IS NOT NULL) = 1
            THEN min(e.product_id) FILTER (WHERE e.product_id IS NOT NULL)
          ELSE '（未填产品）'
        END AS group_key
      FROM events e
      JOIN anchored ON anchored.paywall_session_id = e.paywall_session_id
      WHERE e.project_id = ${project.id}
        AND e.event_name = 'subscribe_clicked'
        ${eventAsOf("e", scope.asOf)}
      GROUP BY e.paywall_session_id
    )
    SELECT
      clicked.group_key,
      count(*)::int AS clicked,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM events purchase
          WHERE purchase.project_id = ${project.id}
            AND purchase.paywall_session_id = clicked.paywall_session_id
            AND purchase.event_name = 'purchase_success'
            ${eventAsOf("purchase", scope.asOf)}
            AND purchase.occurred_at <= COALESCE(
              (
                SELECT min(closed.occurred_at)
                FROM events closed
                WHERE closed.project_id = ${project.id}
                  AND closed.paywall_session_id = clicked.paywall_session_id
                  AND closed.event_name = 'paywall_closed'
                  ${eventAsOf("closed", scope.asOf)}
              ),
              purchase.occurred_at
            ) + (${PURCHASE_WINDOW_MINUTES} * interval '1 minute')
        )
      )::int AS purchased,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM events fail
          WHERE fail.project_id = ${project.id}
            AND fail.paywall_session_id = clicked.paywall_session_id
            AND fail.event_name = 'purchase_failed'
            AND fail.failure_kind = 'payment_error'
            ${eventAsOf("fail", scope.asOf)}
        )
      )::int AS payment_error
    FROM clicked
    GROUP BY clicked.group_key
  `);
  return queryRows(result).map((row) => ({
    key: textCell(row.group_key) || "（未填产品）",
    sessions: 0,
    clicked: intCell(row.clicked),
    purchased: intCell(row.purchased),
    paymentError: intCell(row.payment_error),
  }));
}

function totals(rows: SessionCounts[]): SessionCounts {
  return rows.reduce(
    (sum, row) => ({
      key: "all",
      sessions: sum.sessions + row.sessions,
      clicked: sum.clicked + row.clicked,
      purchased: sum.purchased + row.purchased,
      paymentError: sum.paymentError + row.paymentError,
    }),
    { key: "all", sessions: 0, clicked: 0, purchased: 0, paymentError: 0 },
  );
}

export type FunnelResult = {
  sessions: number;
  clicked: number;
  purchased: number;
  closed_without_purchase: number;
  payment_error: number;
  user_cancelled: number;
  view_to_click: number | null;
  click_to_purchase: number | null;
  overall: number | null;
  failure_rate: number | null;
  daily: DayFunnel[];
};

function rawRate(numerator: number, denominator: number) {
  if (denominator === 0) return null;
  return numerator / denominator;
}

export async function loadFunnel(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
): Promise<FunnelResult> {
  const daily = await queryDailyFunnel(db, project, scope);
  const summed = daily.reduce(
    (sum, day) => ({
      sessions: sum.sessions + day.sessions,
      clicked: sum.clicked + day.clicked,
      purchased: sum.purchased + day.purchased,
      closedWithoutPurchase: sum.closedWithoutPurchase + day.closedWithoutPurchase,
      paymentError: sum.paymentError + day.paymentError,
      userCancelled: sum.userCancelled + day.userCancelled,
    }),
    { sessions: 0, clicked: 0, purchased: 0, closedWithoutPurchase: 0, paymentError: 0, userCancelled: 0 },
  );
  return {
    sessions: summed.sessions,
    clicked: summed.clicked,
    purchased: summed.purchased,
    closed_without_purchase: summed.closedWithoutPurchase,
    payment_error: summed.paymentError,
    user_cancelled: summed.userCancelled,
    view_to_click: rawRate(summed.clicked, summed.sessions),
    click_to_purchase: rawRate(summed.purchased, summed.clicked),
    overall: rawRate(summed.purchased, summed.sessions),
    failure_rate: rawRate(summed.paymentError, summed.clicked),
    daily,
  };
}

export async function getPaywallFunnel(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
  asOf: Date,
): Promise<Envelope<FunnelResult>> {
  const result = await loadFunnel(db, project, scope);
  const view = presentRate(result.purchased, result.sessions);
  return makeEnvelope({
    tool: "get_paywall_funnel",
    args: { period: scope.period, platform: scope.platform, app_version: scope.appVersion, paywall_version: scope.paywallVersion },
    timezone: project.timezone,
    asOf,
    dataThrough: scope.asOf?.toISOString() ?? asOf.toISOString(),
    definitions: FUNNEL_DEFINITIONS,
    sample: { unit: "paywall_session", n: result.sessions, required: MIN_SESSIONS, status: sampleStatus(result.sessions, MIN_SESSIONS) },
    result,
    facts: [
      {
        id: "F1",
        class: "measured",
        text: `展示 ${result.sessions}，点击 ${result.clicked}，购买 ${result.purchased}`,
        source: "funnel",
      },
    ],
    caveats: [
      view.status === "ok" ? "分母不少于 100。" : "样本规则见分群表；概览上的原有比率仍按实际次数计算。",
      "user_cancelled 不计入购买，也不计入支付失败率。",
    ],
  });
}

export type CompareResult = {
  metric: CompareMetric;
  comparable: boolean;
  incomparable_reason: "current_denominator_zero" | "prior_denominator_zero" | null;
  current: RateView;
  previous: RateView;
  delta: number | null;
  signal: Signal;
};

async function responseParts(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
) {
  const { loadReasonCounts } = await import("@/lib/metrics/feedback");
  const [funnel, reasons] = await Promise.all([loadFunnel(db, project, scope), loadReasonCounts(db, project, scope)]);
  let total = 0;
  for (const row of reasons.values()) total += row.count;
  return { numerator: total, denominator: funnel.closed_without_purchase };
}

export async function comparePeriods(
  db: Database,
  project: { id: string; timezone: string },
  input: { metric: CompareMetric; scope: MetricScope; asOf: Date },
): Promise<Envelope<CompareResult>> {
  const priorPeriod = previousPeriod(input.scope.period);
  const priorScope = { ...input.scope, period: priorPeriod };
  const [currentParts, priorParts] = await (async () => {
    if (input.metric === "feedback.response_rate") {
      return Promise.all([responseParts(db, project, input.scope), responseParts(db, project, priorScope)]);
    }
    const [currentRows, priorRows] = await Promise.all([
      querySessionGroups(db, project, input.scope, "platform"),
      querySessionGroups(db, project, priorScope, "platform"),
    ]);
    return [metricParts(input.metric, totals(currentRows)), metricParts(input.metric, totals(priorRows))] as const;
  })();
  const comparable = currentParts.denominator > 0 && priorParts.denominator > 0;
  const reason = !comparable
    ? currentParts.denominator === 0
      ? "current_denominator_zero"
      : "prior_denominator_zero"
    : null;
  const currentView = presentRate(currentParts.numerator, currentParts.denominator);
  const previousView = presentRate(priorParts.numerator, priorParts.denominator);
  const delta = comparable ? currentParts.numerator / currentParts.denominator - priorParts.numerator / priorParts.denominator : null;
  return makeEnvelope({
    tool: "compare_periods",
    args: { metric: input.metric, period: input.scope.period, compare: priorPeriod, platform: input.scope.platform, app_version: input.scope.appVersion, paywall_version: input.scope.paywallVersion, as_of: input.scope.asOf?.toISOString() ?? null },
    timezone: project.timezone,
    asOf: input.asOf,
    dataThrough: input.scope.asOf?.toISOString() ?? input.asOf.toISOString(),
    definitions: {
      ...FUNNEL_DEFINITIONS,
      response_rate: "回答率 = 反馈条数 / 关闭未购买。任一边没有关闭未购买时，不可比。",
    },
    sample: {
      unit: input.metric === "feedback.response_rate" ? "feedback" : "paywall_session",
      n: Math.min(currentParts.denominator, priorParts.denominator),
      required: MIN_SESSIONS,
      status: sampleStatus(Math.min(currentParts.denominator, priorParts.denominator), MIN_SESSIONS),
    },
    result: {
      metric: input.metric,
      comparable,
      incomparable_reason: reason,
      current: currentView,
      previous: previousView,
      delta,
      signal: comparable
        ? compareSignal(currentParts.denominator, priorParts.denominator, currentParts.numerator, priorParts.numerator)
        : "incomparable",
    },
    facts: [],
    caveats: ["任一边分母为 0 时返回不可比，不计算差值。两边分母都少于 30 时不比较比率。"],
  });
}

export type BreakdownGroup = {
  key: string;
  sessions: number | null;
  clicked: number | null;
  purchased: number | null;
  current: RateView;
  previous: RateView;
  within: number | null;
  mix: number | null;
  contribution: number | null;
  signal: Signal;
};

export type BreakdownResult = {
  metric: FunnelMetric;
  dimension: BreakdownDimension;
  groups: BreakdownGroup[];
  comparable: boolean;
  incomparable_reason: "current_denominator_zero" | "prior_denominator_zero" | null;
  overall_delta: number | null;
  compared_groups: number;
  counts: {
    overall_numerator: number;
    overall_denominator: number;
    shown_numerator: number;
    shown_denominator: number;
    hidden_numerator: number;
    hidden_denominator: number;
  };
};

const PRODUCT_METRICS = new Set<FunnelMetric>(["paywall.click_to_purchase", "paywall.failure_rate"]);

export async function breakdownMetric(
  db: Database,
  project: { id: string; timezone: string },
  input: { metric: FunnelMetric; dimension: BreakdownDimension; scope: MetricScope; compare: Period | null; asOf: Date },
): Promise<Envelope<BreakdownResult> | { error: "unsupported_dimension"; message: string }> {
  if (input.dimension === "product_id" && !PRODUCT_METRICS.has(input.metric)) {
    return { error: "unsupported_dimension", message: "product_id 只能拆点击之后的指标，不能拆看到付费页。" };
  }
  const compare = input.compare ?? previousPeriod(input.scope.period);
  const load = (period: Period) =>
    input.dimension === "product_id"
      ? queryProductGroups(db, project, { ...input.scope, period })
      : querySessionGroups(db, project, { ...input.scope, period }, input.dimension);
  const [currentRows, priorRows] = await Promise.all([load(input.scope.period), load(compare)]);
  const currentTotal = metricParts(input.metric, totals(currentRows)).denominator;
  const priorTotal = metricParts(input.metric, totals(priorRows)).denominator;
  const priorByKey = new Map(priorRows.map((row) => [row.key, row]));
  const keys = new Set([...currentRows.map((row) => row.key), ...priorRows.map((row) => row.key)]);
  const raw = [...keys].map((key) => {
    const current = currentRows.find((row) => row.key === key) ?? { key, sessions: 0, clicked: 0, purchased: 0, paymentError: 0 };
    const prior = priorByKey.get(key);
    const currentParts = metricParts(input.metric, current);
    const priorParts = metricParts(input.metric, prior ?? { key, sessions: 0, clicked: 0, purchased: 0, paymentError: 0 });
    return { key, current, currentParts, priorParts, prior };
  });
  const visible = raw.filter((row) => row.currentParts.denominator >= 5);
  const hidden = raw.filter((row) => row.currentParts.denominator < 5);
  const rows = [...visible];
  if (hidden.length > 0) {
    const current = hidden.reduce(
      (sum, row) => ({
        key: "其他",
        sessions: sum.sessions + row.current.sessions,
        clicked: sum.clicked + row.current.clicked,
        purchased: sum.purchased + row.current.purchased,
        paymentError: sum.paymentError + row.current.paymentError,
      }),
      { key: "其他", sessions: 0, clicked: 0, purchased: 0, paymentError: 0 },
    );
    const prior = hidden.reduce(
      (sum, row) => ({
        key: "其他",
        sessions: sum.sessions + (row.prior?.sessions ?? 0),
        clicked: sum.clicked + (row.prior?.clicked ?? 0),
        purchased: sum.purchased + (row.prior?.purchased ?? 0),
        paymentError: sum.paymentError + (row.prior?.paymentError ?? 0),
      }),
      { key: "其他", sessions: 0, clicked: 0, purchased: 0, paymentError: 0 },
    );
    rows.push({
      key: "其他",
      current,
      currentParts: metricParts(input.metric, current),
      priorParts: metricParts(input.metric, prior),
      prior,
    });
  }
  const overallCurrent = metricParts(input.metric, totals(currentRows));
  const overallPrior = metricParts(input.metric, totals(priorRows));
  const comparable = overallCurrent.denominator > 0 && overallPrior.denominator > 0;
  const incomparableReason = comparable
    ? null
    : overallCurrent.denominator === 0
      ? "current_denominator_zero"
      : "prior_denominator_zero";
  let shownNumerator = 0;
  let shownDenominator = 0;
  let hiddenNumerator = 0;
  let hiddenDenominator = 0;
  const groups: BreakdownGroup[] = rows.map((row) => {
    const parts = groupContribution(
      { key: row.key, numerator: row.currentParts.numerator, denominator: row.currentParts.denominator },
      { key: row.key, numerator: row.priorParts.numerator, denominator: row.priorParts.denominator },
      currentTotal,
      priorTotal,
    );
    const currentView = presentRate(row.currentParts.numerator, row.currentParts.denominator);
    const hiddenNumbers = currentView.status === "hidden";
    if (hiddenNumbers) {
      hiddenNumerator += row.currentParts.numerator;
      hiddenDenominator += row.currentParts.denominator;
    } else {
      shownNumerator += row.currentParts.numerator;
      shownDenominator += row.currentParts.denominator;
    }
    return {
      key: row.key,
      sessions: hiddenNumbers ? null : row.current.sessions,
      clicked: hiddenNumbers ? null : row.current.clicked,
      purchased: hiddenNumbers ? null : row.current.purchased,
      current: currentView,
      previous: presentRate(row.priorParts.numerator, row.priorParts.denominator),
      within: comparable ? parts.within : null,
      mix: comparable ? parts.mix : null,
      contribution: comparable ? parts.total : null,
      signal: comparable
        ? compareSignal(row.currentParts.denominator, row.priorParts.denominator, row.currentParts.numerator, row.priorParts.numerator)
        : "incomparable",
    };
  });
  const overallDelta = comparable
    ? overallCurrent.numerator / overallCurrent.denominator - overallPrior.numerator / overallPrior.denominator
    : null;
  return makeEnvelope({
    tool: "breakdown_metric",
    args: { metric: input.metric, dimension: input.dimension, period: input.scope.period, compare },
    timezone: project.timezone,
    asOf: input.asOf,
    dataThrough: input.scope.asOf?.toISOString() ?? input.asOf.toISOString(),
    definitions: FUNNEL_DEFINITIONS,
    sample: {
      unit: "paywall_session",
      n: overallCurrent.denominator,
      required: MIN_SESSIONS,
      status: sampleStatus(overallCurrent.denominator, MIN_SESSIONS),
    },
    result: {
      metric: input.metric,
      dimension: input.dimension,
      groups,
      comparable,
      incomparable_reason: incomparableReason,
      overall_delta: overallDelta,
      compared_groups: visible.length,
      counts: {
        overall_numerator: overallCurrent.numerator,
        overall_denominator: overallCurrent.denominator,
        shown_numerator: shownNumerator,
        shown_denominator: shownDenominator,
        hidden_numerator: hiddenNumerator,
        hidden_denominator: hiddenDenominator,
      },
    },
    facts: [],
    caveats: [
      `比较了 ${visible.length} 个达到 5 次以上的组。少于 5 次的组合并成「其他」。次数隐藏时，变化仍计入合计。`,
      comparable
        ? "组内变化加上占比变化等于整体变化。可展示次数加隐藏次数等于整体。"
        : "有一期分母为 0，不能比较变化。",
      "product_id 按点击归属：只有一个产品归到该产品，多个产品归到「多个产品」，没填产品归到「（未填产品）」。",
    ],
  });
}

export function contributionSum(groups: BreakdownGroup[]) {
  return sumContributions(
    groups
      .filter((group) => group.contribution !== null && group.within !== null && group.mix !== null)
      .map((group) => ({ within: group.within ?? 0, mix: group.mix ?? 0, total: group.contribution ?? 0 })),
  );
}

export function isPlatform(value: string | null | undefined): value is Platform {
  return value === "ios" || value === "android";
}
