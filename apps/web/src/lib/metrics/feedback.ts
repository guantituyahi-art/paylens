import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { anchorCte, type MetricScope } from "@/lib/metrics/anchor";
import { makeEnvelope, type Envelope } from "@/lib/metrics/envelope";
import { loadFunnel } from "@/lib/metrics/paywall";
import { intCell, queryRows, textCell } from "@/lib/metrics/rows";
import { previousPeriod, type Period } from "@/lib/period";
import { MIN_REASON_COUNT, MIN_THEME_COUNT } from "@/lib/thresholds";

export type ReasonRow = {
  code: string;
  label: string;
  count: number;
  share: number;
  prev_count: number;
  prev_share: number | null;
  delta_pp: number | null;
  low_sample: boolean;
};

export type FeedbackReasonsResult = {
  total: number;
  previous_total: number;
  compare: Period;
  closed_without_purchase: number;
  response_rate: number | null;
  reasons: ReasonRow[];
};

const REASON_DEFINITIONS = {
  reason: "只统计挂在本期 paywall_viewed 会话上的反馈。",
  response_rate: "回答率 = 反馈条数 / 关闭未购买。回答的人不代表所有没付钱的人。",
};

export async function loadReasonCounts(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
) {
  const result = await db.execute(sql`
    WITH ${anchorCte(project, scope)}
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
      ${scope.asOf ? sql`AND feedback.received_at <= ${scope.asOf.toISOString()}::timestamptz` : sql``}
    GROUP BY feedback.reason_code
  `);
  const counts = new Map<string, { count: number; label: string }>();
  for (const row of queryRows(result)) {
    const code = textCell(row.code);
    if (!code) continue;
    counts.set(code, { count: intCell(row.count), label: textCell(row.label) });
  }
  return counts;
}

function sumCounts(counts: Map<string, { count: number; label: string }>) {
  let total = 0;
  for (const row of counts.values()) total += row.count;
  return total;
}

export async function getFeedbackReasons(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
  asOf: Date,
): Promise<Envelope<FeedbackReasonsResult>> {
  const compare = previousPeriod(scope.period);
  const [current, previous, funnel] = await Promise.all([
    loadReasonCounts(db, project, scope),
    loadReasonCounts(db, project, { ...scope, period: compare }),
    loadFunnel(db, project, scope),
  ]);
  const total = sumCounts(current);
  const previousTotal = sumCounts(previous);
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
  const responseRate =
    funnel.closed_without_purchase === 0 ? null : total / funnel.closed_without_purchase;
  return makeEnvelope({
    tool: "get_feedback_reasons",
    args: scopeArgs(scope, compare),
    timezone: project.timezone,
    asOf,
    dataThrough: scope.asOf?.toISOString() ?? asOf.toISOString(),
    definitions: REASON_DEFINITIONS,
    sample: {
      unit: "feedback",
      n: total,
      required: MIN_REASON_COUNT,
      status: total < MIN_REASON_COUNT ? "insufficient" : "ok",
    },
    result: {
      total,
      previous_total: previousTotal,
      compare,
      closed_without_purchase: funnel.closed_without_purchase,
      response_rate: responseRate,
      reasons,
    },
    facts: [],
    caveats: ["原因条数少于 30 时，页面仍显示次数，但不把变化当成依据。"],
  });
}

export type ThemeBucket = {
  theme: string;
  count: number;
  examples: string[];
};

export async function getFeedbackThemes(
  db: Database,
  project: { id: string; timezone: string },
  scope: MetricScope,
  asOf: Date,
): Promise<Envelope<{ themes: ThemeBucket[] }>> {
  const result = await db.execute(sql`
    WITH ${anchorCte(project, scope)}
    SELECT feedback.theme, feedback.comment
    FROM feedback
    JOIN anchored ON anchored.paywall_session_id = feedback.paywall_session_id
    WHERE feedback.project_id = ${project.id}
      AND feedback.theme IS NOT NULL
      AND feedback.theme <> ''
      ${scope.asOf ? sql`AND feedback.received_at <= ${scope.asOf.toISOString()}::timestamptz` : sql``}
    ORDER BY feedback.occurred_at DESC, feedback.id DESC
  `);
  const buckets = new Map<string, { count: number; examples: string[] }>();
  for (const row of queryRows(result)) {
    const theme = textCell(row.theme);
    if (!theme) continue;
    const bucket = buckets.get(theme) ?? { count: 0, examples: [] };
    bucket.count += 1;
    const comment = textCell(row.comment).trim();
    if (comment && bucket.examples.length < 2) bucket.examples.push(Array.from(comment).slice(0, 80).join(""));
    buckets.set(theme, bucket);
  }
  const themes = [...buckets.entries()]
    .map(([theme, bucket]) => ({ theme, count: bucket.count, examples: bucket.examples }))
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  const n = themes.reduce((sum, theme) => sum + theme.count, 0);
  return makeEnvelope({
    tool: "get_feedback_themes",
    args: scopeArgs(scope),
    timezone: project.timezone,
    asOf,
    dataThrough: scope.asOf?.toISOString() ?? asOf.toISOString(),
    definitions: { theme: "只统计已经写回 feedback.theme 的评论。每个主题最多 2 条例句，每条最多 80 字。" },
    sample: {
      unit: "feedback",
      n,
      required: MIN_THEME_COUNT,
      status: n < MIN_THEME_COUNT ? "insufficient" : "ok",
    },
    result: { themes },
    facts: [],
    caveats: ["还没归类的评论不会出现在这里。"],
  });
}

function scopeArgs(scope: MetricScope, compare?: Period) {
  return {
    period: scope.period,
    compare,
    platform: scope.platform,
    app_version: scope.appVersion,
    paywall_version: scope.paywallVersion,
    as_of: scope.asOf?.toISOString() ?? null,
  };
}
