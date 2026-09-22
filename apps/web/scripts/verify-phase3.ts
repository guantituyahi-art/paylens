import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client";
import { developers, events, feedback, projectKeys, projects } from "../src/db/schema";
import { getFeedbackComments, getFeedbackSummary } from "../src/lib/feedback-stats";
import { getOverview } from "../src/lib/funnel";
import { ingestFeedback } from "../src/lib/ingest-feedback";
import { redactComment } from "../src/lib/redact-comment";
import { previousPeriod } from "../src/lib/period";

assert.equal(redactComment("请发到 me@example.com，电话 13800138000"), "请发到 [removed]，电话 [removed]");
assert.deepEqual(previousPeriod({ from: "2026-09-20", to: "2026-09-21" }), {
  from: "2026-09-18",
  to: "2026-09-19",
});

const client = new PGlite();
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
for (const file of ["0000_phase0.sql", "0001_phase1.sql", "0002_phase3.sql"]) {
  const statements = readFileSync(join(migrationDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await client.exec(statement);
}
const db = drizzle(client, {
  schema: { developers, projects, projectKeys, events, feedback },
}) as unknown as Database;

const developerId = randomUUID();
await db.insert(developers).values({ id: developerId, email: "phase3@paylens.local" });
const [project] = await db
  .insert(projects)
  .values({ developerId, name: "Phase 3", timezone: "Asia/Shanghai" })
  .returning();
const projectRow = { id: project!.id, timezone: "Asia/Shanghai" };
const activeKey = "pl_pub_phase3activekey000000000000";
const revokedKey = "pl_pub_phase3revokedkey00000000000";
await db.insert(projectKeys).values([
  { projectId: projectRow.id, key: activeKey, status: "active" },
  { projectId: projectRow.id, key: revokedKey, status: "revoked" },
]);

const receivedAt = new Date("2026-09-22T08:00:00.000Z");
const userId = randomUUID();

async function insertViewed(sessionId: string, at: string) {
  await db.insert(events).values({
    projectId: projectRow.id,
    eventId: randomUUID(),
    anonymousUserId: userId,
    paywallSessionId: sessionId,
    eventName: "paywall_viewed",
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: new Date(at),
  });
  await db.insert(events).values({
    projectId: projectRow.id,
    eventId: randomUUID(),
    anonymousUserId: userId,
    paywallSessionId: sessionId,
    eventName: "paywall_closed",
    platform: "ios",
    appVersion: "1.0.0",
    paywallVersion: "A",
    occurredAt: new Date(at),
  });
}

function feedbackBody(input: {
  sessionId: string;
  code: string;
  label: string;
  at: string;
  comment?: string;
  feedbackId?: string;
}) {
  return {
    feedback_id: input.feedbackId ?? randomUUID(),
    anonymous_user_id: userId,
    paywall_session_id: input.sessionId,
    reason_code: input.code,
    reason_label: input.label,
    comment: input.comment ?? null,
    platform: "ios",
    app_version: "1.0.0",
    paywall_version: "A",
    occurred_at: input.at,
  };
}

const sessionA = randomUUID();
const sessionB = randomUUID();
const sessionC = randomUUID();
const previousSession = randomUUID();
const orphanSession = randomUUID();
await insertViewed(sessionA, "2026-09-20T02:00:00.000Z");
await insertViewed(sessionB, "2026-09-20T04:00:00.000Z");
await insertViewed(sessionC, "2026-09-21T01:00:00.000Z");
await insertViewed(previousSession, "2026-09-18T02:00:00.000Z");

const first = await ingestFeedback(
  db,
  activeKey,
  feedbackBody({
    sessionId: sessionA,
    code: "too_expensive",
    label: "价格有点高",
    at: "2026-09-20T02:10:00.000Z",
  }),
  receivedAt,
);
assert.equal(first.status, 200);
const laterLabelId = randomUUID();
await ingestFeedback(
  db,
  activeKey,
  feedbackBody({
    sessionId: sessionB,
    code: "too_expensive",
    label: "有点贵",
    at: "2026-09-20T04:10:00.000Z",
    feedbackId: laterLabelId,
  }),
  receivedAt,
);
await ingestFeedback(
  db,
  activeKey,
  feedbackBody({
    sessionId: sessionB,
    code: "too_expensive",
    label: "有点贵",
    at: "2026-09-20T04:10:00.000Z",
    feedbackId: laterLabelId,
  }),
  receivedAt,
);
await ingestFeedback(
  db,
  activeKey,
  feedbackBody({
    sessionId: sessionC,
    code: "need_more_time",
    label: "还想再体验一下",
    at: "2026-09-21T01:10:00.000Z",
    comment: "联系 a@b.co 或 13800138000",
  }),
  receivedAt,
);
await ingestFeedback(
  db,
  activeKey,
  feedbackBody({
    sessionId: previousSession,
    code: "need_more_time",
    label: "还想再体验一下",
    at: "2026-09-18T02:10:00.000Z",
  }),
  receivedAt,
);
await ingestFeedback(
  db,
  activeKey,
  feedbackBody({
    sessionId: orphanSession,
    code: "other",
    label: "其他",
    at: "2026-09-20T06:00:00.000Z",
    comment: "请发到 me@example.com，电话 13800138000",
  }),
  receivedAt,
);

const storedComment = await db
  .select()
  .from(feedback)
  .where(and(eq(feedback.projectId, projectRow.id), eq(feedback.paywallSessionId, sessionC)));
assert.equal(storedComment[0]?.comment, "联系 [removed] 或 [removed]");
const duplicateRows = await db.select().from(feedback).where(eq(feedback.feedbackId, laterLabelId));
assert.equal(duplicateRows.length, 1);

const tooLong = await ingestFeedback(
  db,
  activeKey,
  feedbackBody({
    sessionId: sessionA,
    code: "other",
    label: "其他",
    at: "2026-09-20T03:00:00.000Z",
    comment: "字".repeat(301),
  }),
  receivedAt,
);
assert.deepEqual(tooLong, { status: 400, body: { error_code: "comment_too_long" } });
const revoked = await ingestFeedback(
  db,
  revokedKey,
  feedbackBody({ sessionId: sessionA, code: "other", label: "其他", at: "2026-09-20T03:00:00.000Z" }),
  receivedAt,
);
assert.deepEqual(revoked, { status: 401, body: { error_code: "key_revoked" } });

const period = { from: "2026-09-20", to: "2026-09-21" };
const summary = await getFeedbackSummary(db, projectRow, { period, appVersion: null, paywallVersion: null });
assert.equal(summary.total, 3);
assert.equal(summary.previous_total, 1);
assert.deepEqual(
  summary.reasons.map((reason) => ({
    code: reason.code,
    label: reason.label,
    count: reason.count,
    share: reason.share,
    prev_count: reason.prev_count,
    delta_pp: reason.delta_pp,
    low_sample: reason.low_sample,
  })),
  [
    {
      code: "too_expensive",
      label: "有点贵",
      count: 2,
      share: 2 / 3,
      prev_count: 0,
      delta_pp: 67,
      low_sample: true,
    },
    {
      code: "need_more_time",
      label: "还想再体验一下",
      count: 1,
      share: 1 / 3,
      prev_count: 1,
      delta_pp: -67,
      low_sample: true,
    },
  ],
);

const overview = await getOverview(db, projectRow, { period, now: receivedAt, appVersion: null, paywallVersion: null });
assert.equal(overview.funnel.sessions, 3);
assert.equal(overview.closed_without_purchase, 3);
assert.equal(overview.feedback_count, 3);
assert.equal(overview.feedback_response_rate, 1);

const textPage = await getFeedbackComments(db, projectRow, {
  period,
  appVersion: null,
  paywallVersion: null,
  textOnly: true,
  cursor: null,
  pageSize: 1,
});
assert.ok(!("error" in textPage));
if (!("error" in textPage)) {
  assert.equal(textPage.comments.length, 1);
  assert.equal(textPage.comments[0]?.orphan, false);
  assert.equal(textPage.comments[0]?.comment, "联系 [removed] 或 [removed]");
  assert.ok(textPage.next_cursor);
  const nextPage = await getFeedbackComments(db, projectRow, {
    period,
    appVersion: null,
    paywallVersion: null,
    textOnly: true,
    cursor: textPage.next_cursor,
    pageSize: 1,
  });
  assert.ok(!("error" in nextPage));
  if (!("error" in nextPage)) {
    assert.equal(nextPage.comments.length, 1);
    assert.equal(nextPage.comments[0]?.orphan, true);
    assert.equal(nextPage.comments[0]?.comment, "请发到 [removed]，电话 [removed]");
    assert.equal(nextPage.next_cursor, null);
  }
}

for (let index = 0; index < 30; index += 1) {
  const currentSession = randomUUID();
  const previousBulkSession = randomUUID();
  await insertViewed(currentSession, "2026-08-01T02:00:00.000Z");
  await insertViewed(previousBulkSession, "2026-07-31T02:00:00.000Z");
  await db.insert(feedback).values([
    {
      projectId: projectRow.id,
      feedbackId: randomUUID(),
      anonymousUserId: userId,
      paywallSessionId: currentSession,
      reasonCode: "enough_data",
      reasonLabel: "样本足够",
      platform: "ios",
      appVersion: "1.0.0",
      paywallVersion: "A",
      occurredAt: new Date("2026-08-01T02:10:00.000Z"),
    },
    {
      projectId: projectRow.id,
      feedbackId: randomUUID(),
      anonymousUserId: userId,
      paywallSessionId: previousBulkSession,
      reasonCode: "enough_data",
      reasonLabel: "样本足够",
      platform: "ios",
      appVersion: "1.0.0",
      paywallVersion: "A",
      occurredAt: new Date("2026-07-31T02:10:00.000Z"),
    },
  ]);
}
const enough = await getFeedbackSummary(db, projectRow, {
  period: { from: "2026-08-01", to: "2026-08-01" },
  appVersion: null,
  paywallVersion: null,
});
assert.equal(enough.reasons[0]?.count, 30);
assert.equal(enough.reasons[0]?.prev_count, 30);
assert.equal(enough.reasons[0]?.low_sample, false);
assert.equal(enough.reasons[0]?.delta_pp, 0);

await client.close();
console.log("ok phase 3 feedback");
