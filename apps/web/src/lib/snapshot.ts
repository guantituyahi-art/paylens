import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { anchorCte, eventAsOf, type Platform } from "@/lib/metrics/anchor";
import { makeEnvelope } from "@/lib/metrics/envelope";
import { getFeedbackReasons, getFeedbackThemes } from "@/lib/metrics/feedback";
import { getPaywallFunnel, PURCHASE_WINDOW_MINUTES, type FunnelResult } from "@/lib/metrics/paywall";
import { previousPeriod, type Period } from "@/lib/period";
import type { ReportSnapshot, SnapshotEvidence } from "@/lib/report-facts";
import { MAX_THEME_COMMENTS, MIN_FEEDBACK, MIN_REASON_COUNT, MIN_SESSIONS } from "@/lib/thresholds";

export type ThemeComment = { id: string; text: string; theme: string | null };

type MeasuredSnapshot = Omit<ReportSnapshot, "facts" | "key_changes" | "caveats" | "comment_themes"> & {
  comments: ThemeComment[];
  evidence: SnapshotEvidence[];
};

type SnapshotFilter = {
  period: Period;
  appVersion: string | null;
  paywallVersion: string | null;
  platform: Platform | null;
  asOf: Date | null;
};

function inclusiveDays(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
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

function funnelCounts(funnel: FunnelResult) {
  return {
    sessions: funnel.sessions,
    clicked: funnel.clicked,
    purchased: funnel.purchased,
    payment_error: funnel.payment_error,
    view_to_click: funnel.view_to_click,
    click_to_purchase: funnel.click_to_purchase,
    overall: funnel.overall,
  };
}

function biggestDrop(funnel: FunnelResult) {
  if (funnel.sessions === 0) return null;
  const viewLost = funnel.sessions - funnel.clicked;
  const clickLost = funnel.clicked - funnel.purchased;
  const rate = (numerator: number, denominator: number) => (denominator === 0 ? null : numerator / denominator);
  return viewLost >= clickLost
    ? { step: "view_to_click" as const, lost: viewLost, lost_rate: rate(viewLost, funnel.sessions) }
    : { step: "click_to_purchase" as const, lost: clickLost, lost_rate: rate(clickLost, funnel.clicked) };
}

function evidenceFrom(
  envelope: { evidence_id: string; tool: string },
  scope: SnapshotFilter,
  compare?: Period,
): SnapshotEvidence {
  return {
    evidence_id: envelope.evidence_id,
    tool: envelope.tool,
    args: {
      period: scope.period,
      compare,
      platform: scope.platform,
      app_version: scope.appVersion,
      paywall_version: scope.paywallVersion,
      as_of: scope.asOf ? scope.asOf.toISOString() : null,
    },
  };
}

async function productCounts(db: Database, project: { id: string; timezone: string }, input: SnapshotFilter) {
  const result = await db.execute(sql`
    WITH ${anchorCte(project, input)},
    closed AS (
      SELECT anchored.paywall_session_id,
             min(events.occurred_at) FILTER (WHERE events.event_name = 'paywall_closed') AS closed_at
      FROM anchored
      JOIN events
        ON events.project_id = ${project.id}
       AND events.paywall_session_id = anchored.paywall_session_id
       ${eventAsOf("events", input.asOf)}
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
          ${eventAsOf("purchase", input.asOf)}
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
      ${eventAsOf("events", input.asOf)}
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

async function themeComments(db: Database, project: { id: string; timezone: string }, input: SnapshotFilter) {
  const result = await db.execute(sql`
    WITH ${anchorCte(project, input)}
    SELECT feedback.id, feedback.comment, feedback.theme
    FROM feedback
    JOIN anchored ON anchored.paywall_session_id = feedback.paywall_session_id
    WHERE feedback.project_id = ${project.id}
      AND feedback.comment IS NOT NULL
      AND feedback.comment <> ''
      ${input.asOf ? sql`AND feedback.received_at <= ${input.asOf.toISOString()}::timestamptz` : sql``}
    ORDER BY feedback.occurred_at DESC, feedback.id DESC
    LIMIT ${MAX_THEME_COMMENTS}
  `);
  return queryRows(result).map((row) => ({
    id: String(row.id),
    text: String(row.comment ?? ""),
    theme: row.theme == null || row.theme === "" ? null : String(row.theme),
  }));
}

export async function buildMeasuredSnapshot(
  db: Database,
  project: { id: string; timezone: string },
  input: {
    period: Period;
    now: Date;
    appVersion: string | null;
    paywallVersion: string | null;
    platform?: Platform | null;
    asOf?: Date | null;
  },
): Promise<MeasuredSnapshot> {
  const compare = previousPeriod(input.period);
  const clock = input.asOf ?? input.now;
  const scope: SnapshotFilter = {
    period: input.period,
    appVersion: input.appVersion,
    paywallVersion: input.paywallVersion,
    platform: input.platform ?? null,
    asOf: input.asOf ?? null,
  };
  const [current, previous, reasons, themes, products, comments] = await Promise.all([
    getPaywallFunnel(db, project, scope, clock),
    getPaywallFunnel(db, project, { ...scope, period: compare }, clock),
    getFeedbackReasons(db, project, scope, clock),
    getFeedbackThemes(db, project, scope, clock),
    productCounts(db, project, scope),
    themeComments(db, project, scope),
  ]);
  const productEvidence = makeEnvelope({
    tool: "product_counts",
    args: evidenceFrom({ evidence_id: "", tool: "product_counts" }, scope).args,
    timezone: project.timezone,
    asOf: clock,
    dataThrough: scope.asOf?.toISOString() ?? clock.toISOString(),
    definitions: { product: "点击按产品计。购买沿用付费页的 10 分钟窗口。" },
    sample: { unit: "paywall_session", n: products.reduce((sum, product) => sum + product.clicked, 0), required: 0, status: "ok" },
    result: { products },
    facts: [],
    caveats: [],
  });
  return {
    timezone: project.timezone,
    period: { start: input.period.from, end: input.period.to, days: inclusiveDays(input.period.from, input.period.to) },
    compare: { start: compare.from, end: compare.to },
    filters: { app_version: input.appVersion, paywall_version: input.paywallVersion, platform: input.platform ?? null },
    thresholds: {
      min_sessions: MIN_SESSIONS,
      min_feedback: MIN_FEEDBACK,
      min_reason_count: MIN_REASON_COUNT,
      met: current.result.sessions >= MIN_SESSIONS && reasons.result.total >= MIN_FEEDBACK,
    },
    funnel: {
      current: funnelCounts(current.result),
      previous: funnelCounts(previous.result),
      biggest_drop: biggestDrop(current.result),
    },
    feedback: {
      total: reasons.result.total,
      closed_without_purchase: reasons.result.closed_without_purchase,
      response_rate: reasons.result.response_rate,
      reasons: reasons.result.reasons,
    },
    by_product: products,
    comments,
    evidence: [
      evidenceFrom(current, scope, compare),
      evidenceFrom(previous, { ...scope, period: compare }),
      evidenceFrom(reasons, scope, compare),
      evidenceFrom(themes, scope),
      evidenceFrom(productEvidence, scope),
    ],
  };
}
