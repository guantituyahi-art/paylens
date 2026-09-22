import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDatabaseUrl, getDb } from "../src/db/client";
import { developers, projectKeys, projects } from "../src/db/schema";
import { generateClientKey, isClientKeyShape } from "../src/lib/client-key";
import { createProjectForDeveloper, ProjectInputError } from "../src/lib/projects";
import { isValidIanaTimezone } from "../src/lib/timezone";

assert.equal(isValidIanaTimezone("Asia/Shanghai"), true);
assert.equal(isValidIanaTimezone("UTC"), true);
assert.equal(isValidIanaTimezone("Asia/Shangha"), false);
assert.equal(isValidIanaTimezone(""), false);
assert.equal(isValidIanaTimezone("Not/AZone"), false);

const clientKey = generateClientKey();
assert.equal(isClientKeyShape(clientKey), true);
assert.notEqual(generateClientKey(), clientKey);

await assert.rejects(
  () =>
    createProjectForDeveloper({} as ReturnType<typeof getDb>, randomUUID(), {
      name: "Demo",
      timezone: "Not/AZone",
    }),
  (error: unknown) => error instanceof ProjectInputError,
);

await assert.rejects(
  () =>
    createProjectForDeveloper({} as ReturnType<typeof getDb>, randomUUID(), {
      name: "   ",
      timezone: "Asia/Shanghai",
    }),
  (error: unknown) => error instanceof ProjectInputError,
);

console.log("ok timezone and client key");

async function verifyDatabase(db: ReturnType<typeof getDb>) {
  const developerId = randomUUID();
  await db.insert(developers).values({
    id: developerId,
    email: `phase0-verify-${developerId}@paylens.local`,
  });

  try {
    const created = await createProjectForDeveloper(db, developerId, {
      name: "Phase 0",
      timezone: "Asia/Shanghai",
    });
    assert.equal(created.project.timezone, "Asia/Shanghai");
    assert.equal(isClientKeyShape(created.clientKey), true);

    const stored = await db
      .select()
      .from(projectKeys)
      .where(eq(projectKeys.projectId, created.project.id));
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.status, "active");
    assert.equal(stored[0]?.key, created.clientKey);

    await assert.rejects(() =>
      db.insert(projectKeys).values({
        projectId: created.project.id,
        key: generateClientKey(),
        status: "nope",
      }),
    );

    const before = await db.select().from(projects).where(eq(projects.developerId, developerId));
    await assert.rejects(
      () =>
        createProjectForDeveloper(db, developerId, {
          name: "Bad timezone",
          timezone: "Mars/Olympus",
        }),
      (error: unknown) => error instanceof ProjectInputError,
    );
    const after = await db.select().from(projects).where(eq(projects.developerId, developerId));
    assert.equal(after.length, before.length);
  } finally {
    await db.delete(projects).where(eq(projects.developerId, developerId));
    await db.delete(developers).where(eq(developers.id, developerId));
  }
}

if (getDatabaseUrl()) {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const db = getDb();
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  await migrate(db, { migrationsFolder });
  try {
    await verifyDatabase(db);
    console.log("ok database: active key created, invalid timezone rejected");
  } finally {
    await closeDb();
  }
} else {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/0000_phase0.sql");
  const statements = readFileSync(migrationPath, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    await client.exec(statement);
  }
  const db = drizzle(client, { schema: { developers, projectKeys, projects } });
  await verifyDatabase(db as unknown as ReturnType<typeof getDb>);
  await client.close();
  console.log("ok database via PGlite: active key created, invalid timezone rejected");
}
