import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client";
import { developers, events, projectKeys, projects } from "../src/db/schema";
import { readEventsRequest } from "../src/lib/events-request";
import { EVENT_NAMES, ingestEvents } from "../src/lib/ingest-events";
import { getIngestionHealth } from "../src/lib/ingestion-health";

const client = new PGlite();
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
for (const file of ["0000_phase0.sql", "0001_phase1.sql", "0005_phase7.sql"]) {
  const statements = readFileSync(join(migrationDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && (file !== "0005_phase7.sql" || !/alter table "feedback"/i.test(statement)));
  for (const statement of statements) await client.exec(statement);
}
const db = drizzle(client, { schema: { developers, projects, projectKeys, events } }) as unknown as Database;

const developerId = randomUUID();
await db.insert(developers).values({ id: developerId, email: "phase1@paylens.local" });
const [project] = await db
  .insert(projects)
  .values({ developerId, name: "Phase 1", timezone: "Asia/Shanghai" })
  .returning();
const activeKey = "pl_pub_phase1activekey000000000000";
const deprecatedKey = "pl_pub_phase1deprecated0000000000";
const revokedKey = "pl_pub_phase1revokedkey00000000000";
await db.insert(projectKeys).values([
  { projectId: project!.id, key: activeKey, status: "active" },
  { projectId: project!.id, key: deprecatedKey, status: "deprecated" },
  { projectId: project!.id, key: revokedKey, status: "revoked" },
]);

const sessionId = randomUUID();
const userId = randomUUID();
const receivedAt = new Date("2026-09-22T08:00:00.000Z");
const names = ["paywall_viewed", "subscribe_clicked", "paywall_closed", "purchase_success"] as const;
const batch = names.map((eventName) => ({
  event_id: randomUUID(),
  event_name: eventName,
  anonymous_user_id: userId,
  paywall_session_id: sessionId,
  platform: "ios",
  app_version: "1.0.1",
  paywall_version: "A",
  occurred_at: receivedAt.toISOString(),
  ...(eventName === "subscribe_clicked" || eventName === "purchase_success" ? { product_id: "pro_monthly" } : {}),
}));

const first = await ingestEvents(db, activeKey, batch, receivedAt);
assert.equal(first.status, 200);
if (first.status === 200) assert.equal(first.body.accepted, 4);
const stored = await db.select().from(events).where(eq(events.projectId, project!.id));
assert.equal(stored.length, 4);
assert.equal(new Set(stored.map((row) => row.paywallSessionId)).size, 1);

const replay = await ingestEvents(db, activeKey, batch, receivedAt);
assert.equal(replay.status, 200);
if (replay.status === 200) assert.equal(replay.body.accepted, 4);
const afterReplay = await db.select().from(events).where(eq(events.projectId, project!.id));
assert.equal(afterReplay.length, 4);

const orphan = await ingestEvents(
  db,
  deprecatedKey,
  [
    {
      event_id: randomUUID(),
      event_name: "subscribe_clicked",
      anonymous_user_id: userId,
      paywall_session_id: randomUUID(),
      platform: "android",
      app_version: "1.0.1",
      occurred_at: receivedAt.toISOString(),
    },
  ],
  receivedAt,
);
assert.equal(orphan.status, 200);
const health = await getIngestionHealth(db, project!.id);
assert.equal(health.orphanSessions, 1);
assert.equal(health.totalEvents, 5);
assert.deepEqual(health.eventNamesSeen, ["paywall_viewed", "subscribe_clicked", "purchase_success", "paywall_closed"]);

const futureEventId = randomUUID();
const future = await ingestEvents(
  db,
  activeKey,
  [
    {
      event_id: futureEventId,
      event_name: "paywall_viewed",
      anonymous_user_id: userId,
      paywall_session_id: randomUUID(),
      platform: "ios",
      app_version: "1.0.1",
      occurred_at: new Date(receivedAt.getTime() + 10 * 60 * 1000).toISOString(),
    },
  ],
  receivedAt,
);
assert.equal(future.status, 200);
const [clamped] = await db.select().from(events).where(eq(events.eventId, futureEventId));
assert.equal(clamped?.occurredAt.getTime(), receivedAt.getTime());

const revoked = await ingestEvents(db, revokedKey, batch, receivedAt);
assert.deepEqual(revoked, { status: 401, body: { error_code: "key_revoked" } });
const missing = await ingestEvents(db, "pl_pub_missing", batch, receivedAt);
assert.deepEqual(missing, { status: 401, body: { error_code: "key_invalid" } });

const limited = await ingestEvents(
  db,
  activeKey,
  [
    {
      event_id: randomUUID(),
      event_name: "paywall_viewed",
      anonymous_user_id: userId,
      paywall_session_id: randomUUID(),
      platform: "ios",
      app_version: "1.0.1",
      occurred_at: receivedAt.toISOString(),
    },
  ],
  receivedAt,
  { dailyLimit: health.totalEvents + 1 },
);
assert.equal(limited.status, 429);

const tooMany = await readEventsRequest(
  new Request("http://localhost/v1/events", {
    method: "POST",
    body: JSON.stringify({ events: Array.from({ length: 51 }, () => ({})) }),
  }),
);
assert.equal(tooMany.ok, false);
if (!tooMany.ok) assert.equal(tooMany.errorCode, "too_many_events");

await client.close();
console.log("ok phase 1 ingestion");
