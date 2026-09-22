import { desc, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { developers, projectKeys, projects } from "@/db/schema";
import { generateClientKey } from "@/lib/client-key";
import { isValidIanaTimezone } from "@/lib/timezone";

const MAX_PROJECT_NAME_LENGTH = 80;

export class ProjectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectInputError";
  }
}

export async function ensureDeveloperRecord(db: Database, user: { id: string; email: string }) {
  await db
    .insert(developers)
    .values({ id: user.id, email: user.email })
    .onConflictDoUpdate({
      target: developers.id,
      set: { email: user.email },
    });
}

export async function createProjectForDeveloper(
  db: Database,
  developerId: string,
  input: { name: string; timezone: string },
) {
  const name = input.name.trim();
  const timezone = input.timezone.trim();
  if (!name || name.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ProjectInputError("请填写项目名称（1–80 个字符）");
  }
  if (!isValidIanaTimezone(timezone)) {
    throw new ProjectInputError("时区必须是合法的 IANA 时区，例如 Asia/Shanghai");
  }

  const clientKey = generateClientKey();
  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ developerId, name, timezone })
      .returning();
    const [keyRow] = await tx
      .insert(projectKeys)
      .values({
        projectId: project.id,
        key: clientKey,
        status: "active",
      })
      .returning();
    return { project, clientKey: keyRow.key };
  });
}

export type ProjectListItem = {
  id: string;
  name: string;
  timezone: string;
  createdAt: Date;
  keys: { id: string; value: string; status: string; label: string | null }[];
};

export async function listProjectsForDeveloper(db: Database, developerId: string) {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      timezone: projects.timezone,
      createdAt: projects.createdAt,
      keyId: projectKeys.id,
      keyValue: projectKeys.key,
      keyStatus: projectKeys.status,
      keyLabel: projectKeys.label,
    })
    .from(projects)
    .leftJoin(projectKeys, eq(projectKeys.projectId, projects.id))
    .where(eq(projects.developerId, developerId))
    .orderBy(desc(projects.createdAt));

  const grouped = new Map<string, ProjectListItem>();
  for (const row of rows) {
    const existing = grouped.get(row.id);
    const item = existing ?? {
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      createdAt: row.createdAt,
      keys: [],
    };
    if (row.keyId && row.keyValue && row.keyStatus) {
      item.keys.push({
        id: row.keyId,
        value: row.keyValue,
        status: row.keyStatus,
        label: row.keyLabel,
      });
    }
    grouped.set(row.id, item);
  }
  return [...grouped.values()];
}
