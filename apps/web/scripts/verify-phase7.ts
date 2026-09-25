import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client";
import { aiReports, developers, events, feedback, projectKeys, projects } from "../src/db/schema";
import { getOverview } from "../src/lib/funnel";
import { ingestEvents } from "../src/lib/ingest-events";
import { getIngestionHealth, getProjectContext, listDimensionValues } from "../src/lib/metrics/context";
import { getFeedbackReasons, getFeedbackThemes } from "../src/lib/metrics/feedback";
import { breakdownMetric, comparePeriods, contributionSum, getPaywallFunnel } from "../src/lib/metrics/paywall";
import { presentRate, wilson95 } from "../src/lib/metrics/sample";
import { buildFacts } from "../src/lib/report-facts";
import { generateReport } from "../src/lib/reports";
import { buildMeasuredSnapshot } from "../src/lib/snapshot";
import type { AiProvider } from "../src/lib/ai-provider";

const zero = wilson95(0, 0);
assert.deepEqual(zero, { low: 0, high: 0 });
const one = wilson95(1, 1);
assert.ok(one.low > 0 && one.low < 1 && one.high === 1);
const middle = wilson95(50, 100);
assert.ok(Math.abs(middle.low - 0.4038) < 0.01);
assert.ok(Math.abs(middle.high - 0.5962) < 0.01);

assert.equal(presentRate(0, 0).status, "hidden");
assert.equal(presentRate(0, 0).rate, null);
assert.equal(presentRate(1, 29).status, "insufficient");
assert.equal(presentRate(1, 29).rate, null);
assert.equal(presentRate(1, 29).numerator, 1);
assert.equal(presentRate(3, 30).status, "small_sample");
assert.equal(presentRate(3, 30).rate, 0.1);
assert.ok(presentRate(3, 30).interval);
assert.equal(presentRate(10, 99).status, "small_sample");
assert.equal(presentRate(10, 100).status, "ok");
assert.equal(presentRate(10, 100).rate, 0.1);
console.log("ok phase 7 sample rules");

const client = new PGlite();
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
for (const file of ["0000_phase0.sql", "0001_phase1.sql", "0002_phase3.sql", "0003_phase4.sql", "0005_phase7.sql"]) {
  const statements = readFileSync(join(migrationDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await client.exec(statement);
}
const db = drizzle(client, {
  schema: { developers, projects, projectKeys, events, feedback, aiReports },
}) as unknown as Database;

async function createProject(name: string, timezone = "Asia/Shanghai") {
  const developerId = randomUUID();
  await db.insert(developers).values({ id: developerId, email: `${name}@paylens.local` });
  const [project] = await db.insert(projects).values({ developerId, name, timezone }).returning();
  const key = `pl_pub_${name}`.padEnd(20, "0").slice(0, 40);
  await db.insert(projectKeys).values({ projectId: project!.id, key, status: "active" });
  return { id: project!.id, timezone, key };
}

const replay = await createProject("phase7-replay");
const userId = randomUUID();
async function view(projectId: string, at: string, extra?: { platform?: string; click?: boolean; purchase?: boolean; close?: boolean }) {
  const sessionId = randomUUID();
  const base = {
    projectId,
    anonymousUserId: userId,
    paywallSessionId: sessionId,
    platform: extra?.platform ?? "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: new Date(at),
  };
  const rows = [{ ...base, eventId: randomUUID(), eventName: "paywall_viewed" }];
  if (extra?.click) rows.push({ ...base, eventId: randomUUID(), eventName: "subscribe_clicked" });
  if (extra?.close) rows.push({ ...base, eventId: randomUUID(), eventName: "paywall_closed" });
  if (extra?.purchase) rows.push({ ...base, eventId: randomUUID(), eventName: "purchase_success" });
  await db.insert(events).values(rows);
}

await view(replay.id, "2026-09-20T02:00:00.000Z", { click: true, purchase: true });
await view(replay.id, "2026-09-20T07:00:00.000Z", { click: true, close: true, purchase: true });
await view(replay.id, "2026-09-21T01:00:00.000Z", { click: true, close: true });
await view(replay.id, "2026-09-21T04:00:00.000Z", { close: true });
await view(replay.id, "2026-09-19T00:00:00.000Z");
const replayNow = new Date("2026-09-22T03:00:00.000Z");
const replayOverview = await getOverview(db, replay, {
  period: { from: "2026-09-19", to: "2026-09-22" },
  now: replayNow,
  appVersion: null,
  paywallVersion: null,
});
assert.equal(replayOverview.funnel.sessions, 5);
assert.equal(replayOverview.funnel.clicked, 3);
assert.equal(replayOverview.funnel.purchased, 2);
assert.equal(replayOverview.closed_without_purchase, 2);
console.log("ok phase 7 keeps phase 2 counts");

const mix = await createProject("phase7-mix");
async function sessions(projectId: string, count: number, purchases: number, platform: string, at: string) {
  for (let index = 0; index < count; index += 1) {
    await view(projectId, at, { platform, purchase: index < purchases });
  }
}
await sessions(mix.id, 80, 40, "ios", "2026-09-03T04:00:00.000Z");
await sessions(mix.id, 20, 4, "android", "2026-09-03T04:00:00.000Z");
await sessions(mix.id, 20, 10, "ios", "2026-09-10T04:00:00.000Z");
await sessions(mix.id, 80, 16, "android", "2026-09-10T04:00:00.000Z");
const mixNow = new Date("2026-09-14T04:00:00.000Z");
const mixPeriod = { from: "2026-09-08", to: "2026-09-14" };
const mixOverview = await getOverview(db, mix, { period: mixPeriod, now: mixNow, appVersion: null, paywallVersion: null });
const iosOnly = await getOverview(db, mix, {
  period: mixPeriod,
  now: mixNow,
  appVersion: null,
  paywallVersion: null,
  platform: "ios",
});
const androidOnly = await getOverview(db, mix, {
  period: mixPeriod,
  now: mixNow,
  appVersion: null,
  paywallVersion: null,
  platform: "android",
});
assert.equal(iosOnly.funnel.sessions + androidOnly.funnel.sessions, mixOverview.funnel.sessions);
assert.equal(iosOnly.funnel.purchased + androidOnly.funnel.purchased, mixOverview.funnel.purchased);
const breakdown = await breakdownMetric(db, mix, {
  metric: "paywall.overall_conversion",
  dimension: "platform",
  scope: { period: mixPeriod, platform: null, appVersion: null, paywallVersion: null, asOf: null },
  compare: null,
  asOf: mixNow,
});
assert.ok(!("error" in breakdown));
if (!("error" in breakdown)) {
  const within = breakdown.result.groups.reduce((sum, group) => sum + (group.within ?? 0), 0);
  const mixShift = breakdown.result.groups.reduce((sum, group) => sum + (group.mix ?? 0), 0);
  assert.ok(Math.abs(within) < 1e-9);
  assert.ok(Math.abs(mixShift - (breakdown.result.overall_delta ?? 0)) < 1e-9);
  assert.ok(Math.abs(contributionSum(breakdown.result.groups) - (breakdown.result.overall_delta ?? 0)) < 1e-9);
  assert.ok(Math.abs((breakdown.result.overall_delta ?? 0) - -0.18) < 1e-9);
}
console.log("ok phase 7 mix shift");

const clock = await createProject("phase7-asof");
const earlyId = randomUUID();
const lateId = randomUUID();
await db.insert(events).values([
  {
    projectId: clock.id,
    eventId: earlyId,
    anonymousUserId: userId,
    paywallSessionId: randomUUID(),
    eventName: "paywall_viewed",
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: new Date("2026-09-10T02:00:00.000Z"),
    receivedAt: new Date("2026-09-10T02:00:00.000Z"),
  },
  {
    projectId: clock.id,
    eventId: lateId,
    anonymousUserId: userId,
    paywallSessionId: randomUUID(),
    eventName: "paywall_viewed",
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: new Date("2026-09-10T03:00:00.000Z"),
    receivedAt: new Date("2026-09-10T05:00:00.000Z"),
  },
]);
const asOf = new Date("2026-09-10T04:00:00.000Z");
const scope = {
  period: { from: "2026-09-10", to: "2026-09-10" },
  platform: null,
  appVersion: null,
  paywallVersion: null,
  asOf,
};
const firstCut = await getPaywallFunnel(db, clock, scope, asOf);
const secondCut = await getPaywallFunnel(db, clock, scope, asOf);
assert.equal(firstCut.result.sessions, secondCut.result.sessions);
assert.equal(firstCut.result.sessions, 1);
const later = await getPaywallFunnel(db, clock, { ...scope, asOf: new Date("2026-09-10T06:00:00.000Z") }, asOf);
assert.equal(later.result.sessions, 2);
console.log("ok phase 7 asOf");

const boundary = await createProject("phase7-boundary");
await view(boundary.id, "2026-09-01T15:59:59.000Z");
await view(boundary.id, "2026-09-01T16:00:00.000Z");
const beforeMidnight = await getOverview(db, boundary, {
  period: { from: "2026-09-01", to: "2026-09-01" },
  now: new Date("2026-09-03T00:00:00.000Z"),
  appVersion: null,
  paywallVersion: null,
});
const afterMidnight = await getOverview(db, boundary, {
  period: { from: "2026-09-02", to: "2026-09-02" },
  now: new Date("2026-09-03T00:00:00.000Z"),
  appVersion: null,
  paywallVersion: null,
});
assert.equal(beforeMidnight.funnel.sessions, 1);
assert.equal(afterMidnight.funnel.sessions, 1);
console.log("ok phase 7 shanghai midnight");

const ingestProject = await createProject("phase7-ingest");
const receivedAt = new Date("2026-09-22T08:00:00.000Z");
const oldEvent = {
  event_id: randomUUID(),
  event_name: "paywall_viewed",
  anonymous_user_id: userId,
  paywall_session_id: randomUUID(),
  platform: "ios",
  app_version: "1.0.0",
  occurred_at: receivedAt.toISOString(),
};
const badFailure = {
  event_id: randomUUID(),
  event_name: "purchase_failed",
  anonymous_user_id: userId,
  paywall_session_id: oldEvent.paywall_session_id,
  platform: "ios",
  app_version: "1.0.0",
  failure_kind: "timeout",
  occurred_at: receivedAt.toISOString(),
};
const ingested = await ingestEvents(db, ingestProject.key, [oldEvent, badFailure], receivedAt);
assert.equal(ingested.status, 200);
if (ingested.status === 200) {
  assert.equal(ingested.body.accepted, 1);
  assert.equal(ingested.body.rejected.length, 1);
  assert.equal(ingested.body.rejected[0]?.error, "invalid_failure_kind");
}
console.log("ok phase 7 old request and bad failure kind");

const cancel = await createProject("phase7-cancel");
const cancelSession = randomUUID();
const cancelAt = new Date("2026-09-20T02:00:00.000Z");
await db.insert(events).values([
  {
    projectId: cancel.id,
    eventId: randomUUID(),
    anonymousUserId: userId,
    paywallSessionId: cancelSession,
    eventName: "paywall_viewed",
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: cancelAt,
  },
  {
    projectId: cancel.id,
    eventId: randomUUID(),
    anonymousUserId: userId,
    paywallSessionId: cancelSession,
    eventName: "subscribe_clicked",
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    productId: "annual",
    occurredAt: new Date("2026-09-20T02:01:00.000Z"),
  },
  {
    projectId: cancel.id,
    eventId: randomUUID(),
    anonymousUserId: userId,
    paywallSessionId: cancelSession,
    eventName: "purchase_failed",
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    productId: "annual",
    failureKind: "user_cancelled",
    occurredAt: new Date("2026-09-20T02:02:00.000Z"),
  },
]);
const cancelOverview = await getOverview(db, cancel, {
  period: { from: "2026-09-20", to: "2026-09-20" },
  now: replayNow,
  appVersion: null,
  paywallVersion: null,
});
assert.equal(cancelOverview.funnel.purchased, 0);
assert.equal(cancelOverview.payment_error, 0);
assert.equal(cancelOverview.user_cancelled, 1);
assert.equal(cancelOverview.funnel.failure_rate, 0);
console.log("ok phase 7 user cancelled");

const themes = await createProject("phase7-themes");
const themeRows = [];
const feedbackRows = [];
for (let index = 0; index < 100; index += 1) {
  const sessionId = randomUUID();
  const occurredAt = new Date("2026-09-20T02:00:00.000Z");
  const base = {
    projectId: themes.id,
    anonymousUserId: userId,
    paywallSessionId: sessionId,
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt,
    receivedAt: occurredAt,
  };
  themeRows.push({ ...base, eventId: randomUUID(), eventName: "paywall_viewed" });
  themeRows.push({ ...base, eventId: randomUUID(), eventName: "paywall_closed" });
  if (index < 20) {
    feedbackRows.push({
      ...base,
      feedbackId: randomUUID(),
      reasonCode: "other",
      reasonLabel: "其他",
      comment: index < 2 ? `评论 ${index}` : null,
      theme: index === 0 ? "unclear_value" : null,
      themeVersion: index === 0 ? "paylens-report-v1" : null,
    });
  }
}
await db.insert(events).values(themeRows);
await db.insert(feedback).values(feedbackRows);
let seenComments: Array<{ id: string }> = [];
const provider: AiProvider = {
  model: "fake",
  async generateStructured(input) {
    if (input.name === "theme_assignments") {
      const body = JSON.parse(input.user) as { comments: Array<{ id: string }> };
      seenComments = body.comments;
      return { assignments: body.comments.map((comment) => ({ comment_id: comment.id, theme: "other" })) };
    }
    return { hypotheses: [], suggested_tests: [], notes: "" };
  },
};
await generateReport(db, themes, {
  periodKind: "7d",
  appVersion: null,
  paywallVersion: null,
  now: replayNow,
  provider,
});
assert.equal(seenComments.length, 1);
const storedThemes = await db.select().from(feedback).where(eq(feedback.projectId, themes.id));
assert.equal(storedThemes.filter((row) => row.theme === "unclear_value").length, 1);
assert.equal(storedThemes.filter((row) => row.comment === "评论 1" && row.theme === "other").length, 1);
console.log("ok phase 7 stored themes");

function assertNoRawUser(value: unknown, secret: string) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("anonymous_user_id"), false);
}

const catalog = await createProject("phase7-catalog");
const catalogUser = randomUUID();
const catalogEarly = new Date("2026-09-10T04:00:00.000Z");
const catalogPrior = new Date("2026-09-09T04:00:00.000Z");
const catalogLate = new Date("2026-09-10T04:30:00.000Z");
const catalogAsOf = new Date("2026-09-10T06:00:00.000Z");
const catalogLateReceived = new Date("2026-09-10T07:00:00.000Z");
const catalogEvents = [];
const catalogFeedback = [];
for (let index = 0; index < 30; index += 1) {
  const sessionId = randomUUID();
  const base = {
    projectId: catalog.id,
    anonymousUserId: catalogUser,
    paywallSessionId: sessionId,
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: catalogEarly,
    receivedAt: catalogEarly,
  };
  catalogEvents.push({ ...base, eventId: randomUUID(), eventName: "paywall_viewed" });
  catalogEvents.push({ ...base, eventId: randomUUID(), eventName: "paywall_closed" });
  if (index === 0) {
    catalogEvents.push({
      ...base,
      eventId: randomUUID(),
      eventName: "subscribe_clicked",
      productId: "annual",
    });
  }
  catalogFeedback.push({
    ...base,
    feedbackId: randomUUID(),
    reasonCode: "too_expensive",
    reasonLabel: "太贵了",
    comment: index < 3 ? "看不懂价值" : null,
    theme: index < 3 ? "unclear_value" : null,
    themeVersion: index < 3 ? "paylens-report-v1" : null,
  });
}
for (let index = 0; index < 10; index += 1) {
  const sessionId = randomUUID();
  const base = {
    projectId: catalog.id,
    anonymousUserId: catalogUser,
    paywallSessionId: sessionId,
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: catalogPrior,
    receivedAt: catalogPrior,
  };
  catalogEvents.push({ ...base, eventId: randomUUID(), eventName: "paywall_viewed" });
  catalogEvents.push({ ...base, eventId: randomUUID(), eventName: "paywall_closed" });
  if (index < 5) {
    catalogFeedback.push({
      ...base,
      feedbackId: randomUUID(),
      reasonCode: "too_expensive",
      reasonLabel: "太贵了",
      comment: null,
      theme: null,
      themeVersion: null,
    });
  }
}
const androidSession = randomUUID();
const androidBase = {
  projectId: catalog.id,
  anonymousUserId: catalogUser,
  paywallSessionId: androidSession,
  platform: "android",
  appVersion: "2.0.0",
  paywallVersion: "B",
  occurredAt: catalogEarly,
  receivedAt: catalogEarly,
};
catalogEvents.push({ ...androidBase, eventId: randomUUID(), eventName: "paywall_viewed" });
catalogEvents.push({ ...androidBase, eventId: randomUUID(), eventName: "paywall_closed" });
catalogFeedback.push({
  ...androidBase,
  feedbackId: randomUUID(),
  reasonCode: "other",
  reasonLabel: "其他",
  comment: null,
  theme: null,
  themeVersion: null,
});
const lateSession = randomUUID();
const lateBase = {
  projectId: catalog.id,
  anonymousUserId: catalogUser,
  paywallSessionId: lateSession,
  platform: "ios",
  appVersion: "9.9.9",
  paywallVersion: "Z",
  occurredAt: catalogLate,
  receivedAt: catalogLateReceived,
};
catalogEvents.push({ ...lateBase, eventId: randomUUID(), eventName: "paywall_viewed" });
catalogEvents.push({ ...lateBase, eventId: randomUUID(), eventName: "subscribe_clicked", productId: "late_sku" });
catalogFeedback.push({
  ...lateBase,
  feedbackId: randomUUID(),
  reasonCode: "too_expensive",
  reasonLabel: "太贵了",
  comment: "晚到的评论",
  theme: "unclear_value",
  themeVersion: "paylens-report-v1",
});
await db.insert(events).values(catalogEvents);
await db.insert(feedback).values(catalogFeedback);

const catalogPeriod = { from: "2026-09-10", to: "2026-09-10" };
const iosScope = {
  period: catalogPeriod,
  platform: "ios" as const,
  appVersion: null,
  paywallVersion: null,
  asOf: catalogAsOf,
};
const reasons = await getFeedbackReasons(db, catalog, iosScope, catalogAsOf);
assert.equal(reasons.tool, "get_feedback_reasons");
assert.equal(reasons.tool_version, "1");
assert.equal(reasons.result.total, 30);
assert.equal(reasons.sample.status, "ok");
assert.equal(reasons.result.reasons.every((row) => row.code === "too_expensive"), true);
const reasonsOpen = await getFeedbackReasons(db, catalog, { ...iosScope, asOf: null }, catalogLateReceived);
assert.equal(reasonsOpen.result.total, 31);
const androidReasons = await getFeedbackReasons(db, catalog, { ...iosScope, platform: "android", asOf: null }, catalogAsOf);
assert.equal(androidReasons.result.total, 1);
assert.equal(androidReasons.sample.status, "insufficient");
const themeEnvelope = await getFeedbackThemes(db, catalog, iosScope, catalogAsOf);
assert.equal(themeEnvelope.result.themes.length, 1);
assert.equal(themeEnvelope.result.themes[0]?.count, 3);
assert.equal(themeEnvelope.sample.status, "ok");
assert.equal(themeEnvelope.result.themes[0]?.examples.length, 2);
const themesOpen = await getFeedbackThemes(db, catalog, { ...iosScope, asOf: null }, catalogLateReceived);
assert.equal(themesOpen.result.themes[0]?.count, 4);
const response = await comparePeriods(db, catalog, {
  metric: "feedback.response_rate",
  scope: iosScope,
  asOf: catalogAsOf,
});
assert.equal(response.result.metric, "feedback.response_rate");
assert.equal(response.result.comparable, true);
assert.equal(response.result.incomparable_reason, null);
assert.ok(Math.abs((response.result.delta ?? 0) - 0.5) < 1e-9);

const healthEarly = await getIngestionHealth(db, catalog, catalogAsOf);
const healthLate = await getIngestionHealth(db, catalog, catalogLateReceived);
assert.equal(healthEarly.sample.status, "ok");
assert.equal(healthEarly.sample.required, 0);
assert.deepEqual(healthEarly.result.rejections, { recorded: false, count: null });
assert.ok(healthEarly.result.total_events < healthLate.result.total_events);
assert.equal(healthLate.result.event_names_seen.includes("subscribe_clicked"), true);
const contextEarly = await getProjectContext(db, catalog, catalogAsOf);
const contextLate = await getProjectContext(db, catalog, catalogLateReceived);
assert.equal(contextEarly.sample.status, "ok");
assert.ok(contextEarly.result.events.count < contextLate.result.events.count);
assert.ok(contextEarly.result.feedback.count < contextLate.result.feedback.count);
const versionsEarly = await listDimensionValues(db, catalog, { dimension: "app_version", scope: iosScope, asOf: catalogAsOf });
assert.ok(!("error" in versionsEarly));
if (!("error" in versionsEarly)) {
  assert.deepEqual(versionsEarly.result.values.map((item) => item.value), ["1.0.0"]);
  assert.equal(versionsEarly.sample.status, "ok");
}
const versionsLate = await listDimensionValues(db, catalog, {
  dimension: "app_version",
  scope: { ...iosScope, platform: null, asOf: catalogLateReceived },
  asOf: catalogLateReceived,
});
assert.ok(!("error" in versionsLate));
if (!("error" in versionsLate)) {
  assert.deepEqual(
    versionsLate.result.values.map((item) => item.value),
    ["1.0.0", "2.0.0", "9.9.9"],
  );
}
const productsEarly = await listDimensionValues(db, catalog, { dimension: "product_id", scope: iosScope, asOf: catalogAsOf });
const productsLate = await listDimensionValues(db, catalog, {
  dimension: "product_id",
  scope: { ...iosScope, asOf: catalogLateReceived },
  asOf: catalogLateReceived,
});
assert.ok(!("error" in productsEarly) && !("error" in productsLate));
if (!("error" in productsEarly) && !("error" in productsLate)) {
  assert.deepEqual(productsEarly.result.values.map((item) => item.value), ["annual"]);
  assert.deepEqual(productsLate.result.values.map((item) => item.value), ["annual", "late_sku"]);
}
for (const envelope of [reasons, themeEnvelope, healthEarly, contextEarly, versionsEarly, productsEarly, response]) {
  assertNoRawUser(envelope, catalogUser);
}
console.log("ok phase 7 catalog tools");

const zeroed = await createProject("phase7-zero");
for (let index = 0; index < 8; index += 1) {
  await view(zeroed.id, "2026-09-09T04:00:00.000Z", { purchase: index < 2 });
}
const zeroBreakdown = await breakdownMetric(db, zeroed, {
  metric: "paywall.overall_conversion",
  dimension: "platform",
  scope: { period: { from: "2026-09-10", to: "2026-09-10" }, platform: null, appVersion: null, paywallVersion: null, asOf: null },
  compare: { from: "2026-09-09", to: "2026-09-09" },
  asOf: new Date("2026-09-11T00:00:00.000Z"),
});
assert.ok(!("error" in zeroBreakdown));
if (!("error" in zeroBreakdown)) {
  assert.equal(zeroBreakdown.result.comparable, false);
  assert.equal(zeroBreakdown.result.incomparable_reason, "current_denominator_zero");
  assert.equal(zeroBreakdown.result.overall_delta, null);
  assert.ok(zeroBreakdown.result.groups.every((group) => group.contribution === null && group.signal === "incomparable"));
}
console.log("ok phase 7 incomparable");

const hidden = await createProject("phase7-hidden");
async function versionSessions(projectId: string, count: number, purchases: number, appVersion: string, at: string) {
  for (let index = 0; index < count; index += 1) {
    const sessionId = randomUUID();
    const occurredAt = new Date(at);
    const rows = [
      {
        projectId,
        eventId: randomUUID(),
        anonymousUserId: userId,
        paywallSessionId: sessionId,
        eventName: "paywall_viewed",
        platform: "ios",
        appVersion,
        paywallVersion: "A",
        occurredAt,
        receivedAt: occurredAt,
      },
    ];
    if (index < purchases) {
      rows.push({
        ...rows[0],
        eventId: randomUUID(),
        eventName: "purchase_success",
      });
    }
    await db.insert(events).values(rows);
  }
}
await versionSessions(hidden.id, 10, 2, "big", "2026-09-09T04:00:00.000Z");
await versionSessions(hidden.id, 10, 4, "big", "2026-09-10T04:00:00.000Z");
await versionSessions(hidden.id, 2, 1, "tiny-a", "2026-09-10T04:00:00.000Z");
await versionSessions(hidden.id, 1, 0, "tiny-b", "2026-09-10T04:00:00.000Z");
const hiddenBreakdown = await breakdownMetric(db, hidden, {
  metric: "paywall.overall_conversion",
  dimension: "app_version",
  scope: { period: { from: "2026-09-10", to: "2026-09-10" }, platform: null, appVersion: null, paywallVersion: null, asOf: null },
  compare: { from: "2026-09-09", to: "2026-09-09" },
  asOf: new Date("2026-09-11T00:00:00.000Z"),
});
assert.ok(!("error" in hiddenBreakdown));
if (!("error" in hiddenBreakdown)) {
  const counts = hiddenBreakdown.result.counts;
  assert.equal(counts.shown_denominator + counts.hidden_denominator, counts.overall_denominator);
  assert.equal(counts.shown_numerator + counts.hidden_numerator, counts.overall_numerator);
  assert.equal(counts.overall_denominator, 13);
  assert.equal(counts.hidden_denominator, 3);
  assert.ok(hiddenBreakdown.result.groups.some((group) => group.key === "其他" && group.sessions === null && group.within !== null));
  assert.ok(Math.abs(contributionSum(hiddenBreakdown.result.groups) - (hiddenBreakdown.result.overall_delta ?? 0)) < 1e-9);
  for (const group of hiddenBreakdown.result.groups) {
    assert.ok(Math.abs((group.within ?? 0) + (group.mix ?? 0) - (group.contribution ?? 0)) < 1e-9);
  }
}
console.log("ok phase 7 hidden groups");

const products = await createProject("phase7-products");
async function clickSession(
  projectId: string,
  at: string,
  productIds: Array<string | null>,
  extra?: { purchase?: boolean; fail?: boolean },
) {
  const sessionId = randomUUID();
  const occurredAt = new Date(at);
  const rows = [
    {
      projectId,
      eventId: randomUUID(),
      anonymousUserId: userId,
      paywallSessionId: sessionId,
      eventName: "paywall_viewed",
      platform: "ios",
      appVersion: "1.0.0",
      paywallVersion: "A",
      productId: null as string | null,
      failureKind: null as string | null,
      occurredAt,
      receivedAt: occurredAt,
    },
  ];
  for (const productId of productIds) {
    rows.push({
      ...rows[0],
      eventId: randomUUID(),
      eventName: "subscribe_clicked",
      productId,
      failureKind: null,
    });
  }
  if (extra?.purchase) {
    rows.push({
      ...rows[0],
      eventId: randomUUID(),
      eventName: "purchase_success",
      productId: productIds.find((productId) => productId) ?? null,
      failureKind: null,
    });
  }
  if (extra?.fail) {
    rows.push({
      ...rows[0],
      eventId: randomUUID(),
      eventName: "purchase_failed",
      productId: productIds.find((productId) => productId) ?? null,
      failureKind: "payment_error",
    });
  }
  await db.insert(events).values(rows);
}
for (let index = 0; index < 6; index += 1) {
  await clickSession(products.id, "2026-09-09T04:00:00.000Z", ["annual"], { purchase: index < 2 });
  await clickSession(products.id, "2026-09-09T04:00:00.000Z", ["monthly"], { purchase: index < 2 });
  await clickSession(products.id, "2026-09-10T04:00:00.000Z", index === 0 ? [null, "annual"] : ["annual"], {
    purchase: index < 3,
  });
  await clickSession(products.id, "2026-09-10T04:00:00.000Z", ["monthly"], { purchase: index < 1 });
}
await clickSession(products.id, "2026-09-10T04:00:00.000Z", ["annual", "monthly"], { fail: true });
await clickSession(products.id, "2026-09-10T04:00:00.000Z", ["annual", "monthly"]);
await clickSession(products.id, "2026-09-10T04:00:00.000Z", [null]);
await clickSession(products.id, "2026-09-10T04:00:00.000Z", [null]);
const productBreakdown = await breakdownMetric(db, products, {
  metric: "paywall.click_to_purchase",
  dimension: "product_id",
  scope: { period: { from: "2026-09-10", to: "2026-09-10" }, platform: null, appVersion: null, paywallVersion: null, asOf: null },
  compare: { from: "2026-09-09", to: "2026-09-09" },
  asOf: new Date("2026-09-11T00:00:00.000Z"),
});
assert.ok(!("error" in productBreakdown));
if (!("error" in productBreakdown)) {
  const counts = productBreakdown.result.counts;
  assert.equal(counts.shown_denominator + counts.hidden_denominator, counts.overall_denominator);
  assert.equal(counts.shown_numerator + counts.hidden_numerator, counts.overall_numerator);
  assert.equal(counts.overall_denominator, 16);
  assert.equal(counts.overall_numerator, 4);
  const byKey = new Map(productBreakdown.result.groups.map((group) => [group.key, group]));
  assert.equal(byKey.get("annual")?.clicked, 6);
  assert.equal(byKey.get("monthly")?.clicked, 6);
  assert.equal(byKey.get("其他")?.clicked, null);
  assert.equal(counts.hidden_denominator, 4);
  assert.ok(Math.abs(contributionSum(productBreakdown.result.groups) - (productBreakdown.result.overall_delta ?? 0)) < 1e-9);
}
const failureBreakdown = await breakdownMetric(db, products, {
  metric: "paywall.failure_rate",
  dimension: "product_id",
  scope: { period: { from: "2026-09-10", to: "2026-09-10" }, platform: null, appVersion: null, paywallVersion: null, asOf: null },
  compare: { from: "2026-09-09", to: "2026-09-09" },
  asOf: new Date("2026-09-11T00:00:00.000Z"),
});
assert.ok(!("error" in failureBreakdown));
if (!("error" in failureBreakdown)) {
  assert.equal(failureBreakdown.result.counts.overall_numerator, 1);
  assert.equal(failureBreakdown.result.counts.hidden_numerator, 1);
}
console.log("ok phase 7 product groups");

const cutoffProject = await createProject("phase7-cutoff", "Asia/Shanghai");
const cutoff = new Date("2026-09-10T04:00:00.000Z");
const earlyAt = new Date("2026-09-10T02:00:00.000Z");
const arrivedLate = new Date("2026-09-10T05:00:00.000Z");
async function snapshotSession(receivedAt: Date, theme: string) {
  const sessionId = randomUUID();
  const occurredAt = earlyAt;
  const base = {
    projectId: cutoffProject.id,
    anonymousUserId: userId,
    paywallSessionId: sessionId,
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt,
    receivedAt,
  };
  await db.insert(events).values([
    { ...base, eventId: randomUUID(), eventName: "paywall_viewed" },
    { ...base, eventId: randomUUID(), eventName: "subscribe_clicked", productId: "annual" },
    { ...base, eventId: randomUUID(), eventName: "purchase_success", productId: "annual" },
    { ...base, eventId: randomUUID(), eventName: "purchase_failed", productId: "annual", failureKind: "payment_error" },
  ]);
  await db.insert(feedback).values({
    ...base,
    feedbackId: randomUUID(),
    reasonCode: "too_expensive",
    reasonLabel: "太贵了",
    comment: "截止测试",
    theme,
    themeVersion: "paylens-report-v1",
  });
}
for (let index = 0; index < 3; index += 1) await snapshotSession(earlyAt, "unclear_value");
await snapshotSession(arrivedLate, "other");
const cutoffInput = {
  period: { from: "2026-09-10", to: "2026-09-10" },
  now: cutoff,
  appVersion: "1.0.0",
  paywallVersion: "A",
  platform: "ios" as const,
};
const cutSnapshot = await buildMeasuredSnapshot(db, cutoffProject, { ...cutoffInput, asOf: cutoff });
const openSnapshot = await buildMeasuredSnapshot(db, cutoffProject, cutoffInput);
assert.equal(cutSnapshot.funnel.current.clicked, 3);
assert.equal(cutSnapshot.funnel.current.purchased, 3);
assert.equal(cutSnapshot.funnel.current.payment_error, 3);
assert.equal(cutSnapshot.feedback.total, 3);
assert.equal(cutSnapshot.by_product[0]?.clicked, 3);
assert.equal(openSnapshot.funnel.current.clicked, 4);
assert.equal(openSnapshot.funnel.current.purchased, 4);
assert.equal(openSnapshot.funnel.current.payment_error, 4);
assert.equal(openSnapshot.feedback.total, 4);
assert.equal(openSnapshot.by_product[0]?.clicked, 4);
const cutFacts = buildFacts({ ...cutSnapshot, comment_themes: [{ theme: "unclear_value", count: 3, examples: ["截止测试"] }] });
assert.equal(cutFacts.facts[0]?.id, "F1");
assert.ok(cutFacts.facts.every((fact) => /^F\d+$/.test(fact.id)));
for (const fact of cutFacts.facts) {
  const evidence = cutSnapshot.evidence.find((item) => item.evidence_id === fact.evidence_id);
  assert.ok(evidence, fact.id);
  assert.equal(evidence?.args.as_of, cutoff.toISOString());
  assert.equal(evidence?.args.platform, "ios");
  assert.equal(evidence?.args.app_version, "1.0.0");
  assert.equal(evidence?.args.paywall_version, "A");
  assert.equal(evidence?.args.period.from, "2026-09-10");
}
const reasonFact = cutFacts.facts.find((fact) => fact.source_keys.some((key) => key.startsWith("feedback.reasons")));
const themeFact = cutFacts.facts.find((fact) => fact.source_keys.some((key) => key.startsWith("comment_themes")));
assert.equal(cutSnapshot.evidence.find((item) => item.evidence_id === reasonFact?.evidence_id)?.tool, "get_feedback_reasons");
assert.equal(cutSnapshot.evidence.find((item) => item.evidence_id === themeFact?.evidence_id)?.tool, "get_feedback_themes");
assert.equal(cutSnapshot.evidence.find((item) => item.tool === "get_paywall_funnel")?.evidence_id, cutFacts.facts[0]?.evidence_id);
console.log("ok phase 7 report cutoff and evidence");

const losAngeles = await createProject("phase7-la", "America/Los_Angeles");
await view(losAngeles.id, "2026-09-02T06:59:59.000Z");
await view(losAngeles.id, "2026-09-02T07:00:00.000Z");
const laBefore = await getOverview(db, losAngeles, {
  period: { from: "2026-09-01", to: "2026-09-01" },
  now: new Date("2026-09-03T00:00:00.000Z"),
  appVersion: null,
  paywallVersion: null,
});
const laAfter = await getOverview(db, losAngeles, {
  period: { from: "2026-09-02", to: "2026-09-02" },
  now: new Date("2026-09-03T00:00:00.000Z"),
  appVersion: null,
  paywallVersion: null,
});
assert.equal(laBefore.funnel.sessions, 1);
assert.equal(laAfter.funnel.sessions, 1);
console.log("ok phase 7 los angeles midnight");

await client.close();
console.log("ok phase 7");
