import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client";
import { aiReports, developers, events, feedback, projectKeys, projects } from "../src/db/schema";
import { ingestEvents } from "../src/lib/ingest-events";
import {
  clearProjectData,
  createProjectKey,
  deleteAnonymousUserData,
  SettingsError,
  updateProjectKeyStatus,
  updateProjectSettings,
} from "../src/lib/project-settings";

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const retentionSql = readFileSync(join(migrationDir, "0004_phase5_retention.sql"), "utf8");
assert.match(retentionSql, /paylens_delete_expired_rows/);
assert.match(retentionSql, /CREATE OR REPLACE FUNCTION paylens_delete_expired_rows\s*\(/i);
assert.match(retentionSql, /paylens-retention-cleanup/);
assert.match(retentionSql, /15 3 \* \* \*/);
assert.match(
  retentionSql,
  /cron\.schedule\(\s*'paylens-retention-cleanup'\s*,\s*'15 3 \* \* \*'\s*,\s*\$\$SELECT paylens_delete_expired_rows\(\);\$\$\s*\)/s,
);
assert.match(retentionSql, /DELETE FROM events/i);
assert.match(retentionSql, /DELETE FROM feedback/i);
assert.match(retentionSql, /retention_days/);
assert.equal(/DELETE FROM ai_reports/i.test(retentionSql), false);
assert.equal(/CREATE EXTENSION/i.test(retentionSql), false);
assert.match(retentionSql, /cron\.unschedule/);

const client = new PGlite();
for (const file of ["0000_phase0.sql", "0001_phase1.sql", "0002_phase3.sql", "0003_phase4.sql"]) {
  const statements = readFileSync(join(migrationDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await client.exec(statement);
}
const db = drizzle(client, {
  schema: { developers, projects, projectKeys, events, feedback, aiReports },
}) as unknown as Database;

const developerId = randomUUID();
await db.insert(developers).values({ id: developerId, email: "phase5@paylens.local" });
const [project] = await db
  .insert(projects)
  .values({ developerId, name: "Phase5", timezone: "Asia/Shanghai" })
  .returning();
assert.ok(project);

const updated = await updateProjectSettings(db, project.id, { timezone: "America/Los_Angeles" });
assert.equal(updated.timezone, "America/Los_Angeles");
try {
  await updateProjectSettings(db, project.id, { timezone: "Not/AZone" });
  assert.fail("invalid timezone should throw");
} catch (error) {
  assert.ok(error instanceof SettingsError);
  assert.equal(error.code, "invalid_timezone");
}

const activeKey = "pl_pub_phase5activekey000000000000";
const deprecatedKey = "pl_pub_phase5deprecated0000000000";
await db.insert(projectKeys).values([
  { projectId: project.id, key: activeKey, status: "active", label: "primary" },
  { projectId: project.id, key: deprecatedKey, status: "deprecated", label: "old" },
]);

const touchAt = new Date("2026-09-22T10:00:00.000Z");
const deprecatedIngest = await ingestEvents(
  db,
  deprecatedKey,
  [
    {
      event_id: randomUUID(),
      event_name: "paywall_viewed",
      anonymous_user_id: randomUUID(),
      paywall_session_id: randomUUID(),
      platform: "ios",
      app_version: "1.0.0",
      occurred_at: touchAt.toISOString(),
    },
  ],
  touchAt,
);
assert.equal(deprecatedIngest.status, 200);
const [touched] = await db.select().from(projectKeys).where(eq(projectKeys.key, deprecatedKey));
assert.equal(touched?.lastUsedAt?.getTime(), touchAt.getTime());

const lastActiveDev = randomUUID();
await db.insert(developers).values({ id: lastActiveDev, email: "phase5-last@paylens.local" });
const [soloProject] = await db
  .insert(projects)
  .values({ developerId: lastActiveDev, name: "Phase5Solo", timezone: "Asia/Shanghai" })
  .returning();
assert.ok(soloProject);
const onlyKey = await createProjectKey(db, soloProject.id, "only");
await updateProjectKeyStatus(db, soloProject.id, onlyKey.id, "deprecated");
try {
  await updateProjectKeyStatus(db, soloProject.id, onlyKey.id, "revoked");
  assert.fail("revoking without an active key should fail");
} catch (error) {
  assert.ok(error instanceof SettingsError);
  assert.equal(error.code, "last_active_key");
}
const [stillDeprecated] = await db.select().from(projectKeys).where(eq(projectKeys.id, onlyKey.id));
assert.equal(stillDeprecated?.status, "deprecated");

const replacement = await createProjectKey(db, soloProject.id, "replacement");
assert.equal(replacement.status, "active");
const revoked = await updateProjectKeyStatus(db, soloProject.id, onlyKey.id, "revoked");
assert.equal(revoked.status, "revoked");
assert.ok(revoked.revokedAt);

const [activeOnly] = await db.select().from(projectKeys).where(eq(projectKeys.key, activeKey));
try {
  await updateProjectKeyStatus(db, project.id, activeOnly!.id, "revoked");
  assert.fail("active → revoked should be rejected");
} catch (error) {
  assert.ok(error instanceof SettingsError);
  assert.equal(error.code, "invalid_transition");
}

const userKeep = "user-keep-phase5";
const userDelete = "user-delete-phase5";
const sessionKeep = randomUUID();
const sessionDelete = randomUUID();
const occurredAt = new Date("2026-09-20T02:00:00.000Z");
await db.insert(events).values([
  {
    projectId: project.id,
    eventId: randomUUID(),
    anonymousUserId: userKeep,
    paywallSessionId: sessionKeep,
    eventName: "paywall_viewed",
    platform: "ios",
    appVersion: "1.0.0",
    occurredAt,
  },
  {
    projectId: project.id,
    eventId: randomUUID(),
    anonymousUserId: userDelete,
    paywallSessionId: sessionDelete,
    eventName: "paywall_viewed",
    platform: "ios",
    appVersion: "1.0.0",
    occurredAt,
  },
  {
    projectId: project.id,
    eventId: randomUUID(),
    anonymousUserId: userDelete,
    paywallSessionId: sessionDelete,
    eventName: "paywall_closed",
    platform: "ios",
    appVersion: "1.0.0",
    occurredAt,
  },
]);
await db.insert(feedback).values([
  {
    projectId: project.id,
    feedbackId: randomUUID(),
    anonymousUserId: userKeep,
    paywallSessionId: sessionKeep,
    reasonCode: "too_expensive",
    reasonLabel: "太贵了",
    platform: "ios",
    appVersion: "1.0.0",
    occurredAt,
  },
  {
    projectId: project.id,
    feedbackId: randomUUID(),
    anonymousUserId: userDelete,
    paywallSessionId: sessionDelete,
    reasonCode: "need_time",
    reasonLabel: "再想想",
    platform: "ios",
    appVersion: "1.0.0",
    occurredAt,
  },
]);

const deleted = await deleteAnonymousUserData(db, project.id, userDelete);
assert.equal(deleted.deletedEvents, 2);
assert.equal(deleted.deletedFeedback, 1);
const leftoverEvents = await db
  .select()
  .from(events)
  .where(and(eq(events.projectId, project.id), eq(events.anonymousUserId, userDelete)));
const leftoverFeedback = await db
  .select()
  .from(feedback)
  .where(and(eq(feedback.projectId, project.id), eq(feedback.anonymousUserId, userDelete)));
assert.equal(leftoverEvents.length, 0);
assert.equal(leftoverFeedback.length, 0);
const keptEvents = await db
  .select()
  .from(events)
  .where(and(eq(events.projectId, project.id), eq(events.anonymousUserId, userKeep)));
const keptFeedback = await db
  .select()
  .from(feedback)
  .where(and(eq(feedback.projectId, project.id), eq(feedback.anonymousUserId, userKeep)));
assert.equal(keptEvents.length, 1);
assert.equal(keptFeedback.length, 1);

await db.insert(aiReports).values({
  projectId: project.id,
  timezone: project.timezone,
  periodStart: "2026-09-15",
  periodEnd: "2026-09-21",
  compareStart: "2026-09-08",
  compareEnd: "2026-09-14",
  status: "insufficient_data",
  filters: {},
});
const cleared = await clearProjectData(db, project.id);
assert.ok(cleared.deletedEvents >= 1);
assert.ok(cleared.deletedFeedback >= 1);
assert.equal(cleared.deletedReports, 1);
const afterClearEvents = await db.select().from(events).where(eq(events.projectId, project.id));
const afterClearFeedback = await db.select().from(feedback).where(eq(feedback.projectId, project.id));
const afterClearReports = await db.select().from(aiReports).where(eq(aiReports.projectId, project.id));
assert.equal(afterClearEvents.length, 0);
assert.equal(afterClearFeedback.length, 0);
assert.equal(afterClearReports.length, 0);
const keysRemain = await db.select().from(projectKeys).where(eq(projectKeys.projectId, project.id));
assert.ok(keysRemain.length >= 1);

await client.close();
console.log("phase 5 ok");
