import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client";
import { developers, events, projects } from "../src/db/schema";
import { getFilterOptions, getOverview, type Overview } from "../src/lib/funnel";
import { parseDashboardQuery, resolvePeriod } from "../src/lib/period";

const clock = new Date("2026-09-21T16:30:00.000Z");
const shanghaiWeek = resolvePeriod({ timezone: "Asia/Shanghai", now: clock, range: "7d" });
const losAngelesWeek = resolvePeriod({ timezone: "America/Los_Angeles", now: clock, range: "7d" });
assert.equal(shanghaiWeek.ok && shanghaiWeek.period.to, "2026-09-22");
assert.equal(shanghaiWeek.ok && shanghaiWeek.period.from, "2026-09-16");
assert.equal(losAngelesWeek.ok && losAngelesWeek.period.to, "2026-09-21");
assert.equal(losAngelesWeek.ok && losAngelesWeek.period.from, "2026-09-15");
const reversed = resolvePeriod({
  timezone: "Asia/Shanghai",
  now: clock,
  from: "2026-09-22",
  to: "2026-09-01",
});
assert.equal(reversed.ok, false);

const client = new PGlite();
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
for (const file of ["0000_phase0.sql", "0001_phase1.sql", "0002_phase3.sql", "0005_phase7.sql"]) {
  const statements = readFileSync(join(migrationDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await client.exec(statement);
}
const db = drizzle(client, { schema: { developers, projects, events } }) as unknown as Database;

const developerId = randomUUID();
await db.insert(developers).values({ id: developerId, email: "phase2@paylens.local" });
const [project] = await db
  .insert(projects)
  .values({ developerId, name: "Phase 2", timezone: "Asia/Shanghai" })
  .returning();
const projectRow = { id: project!.id, timezone: "Asia/Shanghai" };
const userId = randomUUID();
const sessionA = randomUUID();
const sessionB = randomUUID();
const sessionC = randomUUID();
const sessionD = randomUUID();
const sessionE = randomUUID();
const orphanSession = randomUUID();
const boundarySession = randomUUID();

async function insertEvent(input: {
  sessionId: string;
  name: string;
  at: string;
  appVersion?: string;
  paywallVersion?: string | null;
  userId?: string;
}) {
  await db.insert(events).values({
    projectId: projectRow.id,
    eventId: randomUUID(),
    anonymousUserId: input.userId ?? userId,
    paywallSessionId: input.sessionId,
    eventName: input.name,
    platform: "ios",
    appVersion: input.appVersion ?? "1.0.0",
    paywallVersion: input.paywallVersion === undefined ? "A" : input.paywallVersion,
    occurredAt: new Date(input.at),
  });
}

// 同一用户 5 次展示。上海时间：
// A 09-20 看到、点击、购买，没关闭 → purchased
// B 09-20 关闭后正好 10 分钟购买 → purchased，不算关闭未购买
// C 09-21 关闭后 10 分 01 秒购买 → 事件保留，但不算 purchased
// D 09-21 只关闭 → 关闭未购买
// E 09-19 只看到
await insertEvent({ sessionId: sessionA, name: "paywall_viewed", at: "2026-09-20T02:00:00.000Z" });
await insertEvent({ sessionId: sessionA, name: "subscribe_clicked", at: "2026-09-20T02:01:00.000Z" });
await insertEvent({ sessionId: sessionA, name: "purchase_success", at: "2026-09-20T02:02:00.000Z" });

await insertEvent({ sessionId: sessionB, name: "paywall_viewed", at: "2026-09-20T07:00:00.000Z" });
await insertEvent({ sessionId: sessionB, name: "subscribe_clicked", at: "2026-09-20T07:01:00.000Z" });
await insertEvent({ sessionId: sessionB, name: "paywall_closed", at: "2026-09-20T07:05:00.000Z" });
await insertEvent({ sessionId: sessionB, name: "purchase_success", at: "2026-09-20T07:15:00.000Z" });

await insertEvent({ sessionId: sessionC, name: "paywall_viewed", at: "2026-09-21T01:00:00.000Z" });
await insertEvent({ sessionId: sessionC, name: "subscribe_clicked", at: "2026-09-21T01:01:00.000Z" });
await insertEvent({ sessionId: sessionC, name: "paywall_closed", at: "2026-09-21T01:05:00.000Z" });
await insertEvent({
  sessionId: sessionC,
  name: "purchase_success",
  at: "2026-09-21T01:15:01.000Z",
  appVersion: "9.9.9",
  paywallVersion: "Z",
});

await insertEvent({
  sessionId: sessionD,
  name: "paywall_viewed",
  at: "2026-09-21T04:00:00.000Z",
  appVersion: "2.0.0",
  paywallVersion: "B",
});
await insertEvent({
  sessionId: sessionD,
  name: "paywall_closed",
  at: "2026-09-21T04:10:00.000Z",
  appVersion: "2.0.0",
  paywallVersion: "B",
});

await insertEvent({ sessionId: sessionE, name: "paywall_viewed", at: "2026-09-19T00:00:00.000Z" });

await insertEvent({ sessionId: orphanSession, name: "subscribe_clicked", at: "2026-09-20T03:00:00.000Z" });
await insertEvent({ sessionId: orphanSession, name: "purchase_success", at: "2026-09-20T03:01:00.000Z" });

for (const at of ["2026-09-10T02:00:00.000Z", "2026-09-10T03:00:00.000Z", "2026-09-10T04:00:00.000Z"]) {
  const sessionId = randomUUID();
  await insertEvent({
    sessionId,
    name: "paywall_viewed",
    at,
    appVersion: "3.0.0",
    paywallVersion: "C",
  });
  await insertEvent({
    sessionId,
    name: "subscribe_clicked",
    at,
    appVersion: "3.0.0",
    paywallVersion: "C",
  });
  await insertEvent({
    sessionId,
    name: "paywall_closed",
    at,
    appVersion: "3.0.0",
    paywallVersion: "C",
  });
}

// 2026-09-01 16:30 UTC = 上海 09-02 00:30，洛杉矶 09-01 09:30。
await insertEvent({ sessionId: boundarySession, name: "paywall_viewed", at: "2026-09-01T16:30:00.000Z" });

const now = new Date("2026-09-22T03:00:00.000Z");
const period = { from: "2026-09-19", to: "2026-09-22" };

function assertRate(actual: number | null, numerator: number, denominator: number) {
  if (denominator === 0) {
    assert.equal(actual, null);
    return;
  }
  assert.equal(actual, numerator / denominator);
}

function assertFunnel(overview: Overview, expected: { sessions: number; clicked: number; purchased: number; closed: number }) {
  assert.equal(overview.funnel.sessions, expected.sessions);
  assert.equal(overview.funnel.clicked, expected.clicked);
  assert.equal(overview.funnel.purchased, expected.purchased);
  assert.equal(overview.closed_without_purchase, expected.closed);
  assertRate(overview.funnel.view_to_click, expected.clicked, expected.sessions);
  assertRate(overview.funnel.click_to_purchase, expected.purchased, expected.clicked);
  assertRate(overview.funnel.overall, expected.purchased, expected.sessions);
  assert.equal(
    overview.daily.reduce((sum, day) => sum + day.sessions, 0),
    overview.funnel.sessions,
  );
}

const main = await getOverview(db, projectRow, { period, now, appVersion: null, paywallVersion: null });
assertFunnel(main, { sessions: 5, clicked: 3, purchased: 2, closed: 2 });
assert.equal(main.feedback_count, 0);
assert.equal(main.feedback_response_rate, 0);
assert.deepEqual(main.biggest_drop, { step: "view_to_click", lost: 2, lost_rate: 2 / 5 });
assert.deepEqual(
  main.daily.map((day) => ({ date: day.date, sessions: day.sessions, purchased: day.purchased, partial: day.partial })),
  [
    { date: "2026-09-19", sessions: 1, purchased: 0, partial: false },
    { date: "2026-09-20", sessions: 2, purchased: 2, partial: false },
    { date: "2026-09-21", sessions: 2, purchased: 0, partial: false },
    { date: "2026-09-22", sessions: 0, purchased: 0, partial: true },
  ],
);
assert.equal(main.daily[3]?.overall, null);
assert.equal(main.health.orphan_sessions, 1);
assert.equal(main.health.event_names_seen.length, 4);

const storedOutsideWindow = await db
  .select()
  .from(events)
  .where(and(eq(events.paywallSessionId, sessionC), eq(events.eventName, "purchase_success")));
assert.equal(storedOutsideWindow.length, 1);
const storedOrphan = await db.select().from(events).where(eq(events.paywallSessionId, orphanSession));
assert.equal(storedOrphan.length, 2);

const filters = await getFilterOptions(db, projectRow, period);
assert.deepEqual(filters, { platforms: ["ios"], app_versions: ["1.0.0", "2.0.0"], paywall_versions: ["A", "B"] });

const onlyNewApp = await getOverview(db, projectRow, { period, now, appVersion: "2.0.0", paywallVersion: null });
assertFunnel(onlyNewApp, { sessions: 1, clicked: 0, purchased: 0, closed: 1 });

const withoutNewApp = await getOverview(db, projectRow, { period, now, appVersion: "1.0.0", paywallVersion: null });
assertFunnel(withoutNewApp, { sessions: 4, clicked: 3, purchased: 2, closed: 1 });
assert.deepEqual(withoutNewApp.biggest_drop, { step: "view_to_click", lost: 1, lost_rate: 1 / 4 });

const onlyPaywallB = await getOverview(db, projectRow, { period, now, appVersion: null, paywallVersion: "B" });
assertFunnel(onlyPaywallB, { sessions: 1, clicked: 0, purchased: 0, closed: 1 });

const clickDrop = await getOverview(db, projectRow, {
  period: { from: "2026-09-10", to: "2026-09-10" },
  now,
  appVersion: null,
  paywallVersion: null,
});
assertFunnel(clickDrop, { sessions: 3, clicked: 3, purchased: 0, closed: 3 });
assert.deepEqual(clickDrop.biggest_drop, { step: "click_to_purchase", lost: 3, lost_rate: 1 });

const empty = await getOverview(db, projectRow, {
  period: { from: "2026-08-01", to: "2026-08-01" },
  now,
  appVersion: null,
  paywallVersion: null,
});
assertFunnel(empty, { sessions: 0, clicked: 0, purchased: 0, closed: 0 });
assert.equal(empty.biggest_drop, null);
assert.equal(empty.feedback_response_rate, null);
assert.equal(empty.daily[0]?.partial, false);

const parsed = parseDashboardQuery("Asia/Shanghai", { from: "2026-09-19", to: "2026-09-22", app_version: " 1.0.0 " }, now);
assert.equal(parsed.ok && parsed.query.appVersion, "1.0.0");
assert.equal(parsed.ok && parsed.query.period.from, "2026-09-19");

await db.update(projects).set({ timezone: "America/Los_Angeles" }).where(eq(projects.id, projectRow.id));
const losAngeles = { id: projectRow.id, timezone: "America/Los_Angeles" };
const laNextDay = await getOverview(db, losAngeles, {
  period: { from: "2026-09-02", to: "2026-09-02" },
  now,
  appVersion: null,
  paywallVersion: null,
});
const laSameDay = await getOverview(db, losAngeles, {
  period: { from: "2026-09-01", to: "2026-09-01" },
  now,
  appVersion: null,
  paywallVersion: null,
});
assert.equal(laNextDay.funnel.sessions, 0);
assert.equal(laSameDay.funnel.sessions, 1);

await db.update(projects).set({ timezone: "Asia/Shanghai" }).where(eq(projects.id, projectRow.id));
const shanghaiNextDay = await getOverview(db, projectRow, {
  period: { from: "2026-09-02", to: "2026-09-02" },
  now,
  appVersion: null,
  paywallVersion: null,
});
const shanghaiSameDay = await getOverview(db, projectRow, {
  period: { from: "2026-09-01", to: "2026-09-01" },
  now,
  appVersion: null,
  paywallVersion: null,
});
assert.equal(shanghaiNextDay.funnel.sessions, 1);
assert.equal(shanghaiSameDay.funnel.sessions, 0);

await client.close();
console.log("ok phase 2 funnel");
