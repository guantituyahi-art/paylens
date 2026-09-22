import { and, count, eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { aiReports, events, feedback, projectKeys, projects } from "@/db/schema";
import { generateClientKey } from "@/lib/client-key";
import { isValidIanaTimezone } from "@/lib/timezone";

const MAX_PROJECT_NAME_LENGTH = 80;
const MAX_KEY_LABEL_LENGTH = 80;

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

export type ProjectKeyRow = {
  id: string;
  key: string;
  label: string | null;
  status: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deprecatedAt: Date | null;
  revokedAt: Date | null;
};

export async function updateProjectSettings(
  db: Database,
  projectId: string,
  input: { name?: string; timezone?: string },
) {
  const patch: { name?: string; timezone?: string } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > MAX_PROJECT_NAME_LENGTH) {
      throw new SettingsError("请填写项目名称（1–80 个字符）", "invalid_name");
    }
    patch.name = name;
  }
  if (input.timezone !== undefined) {
    const timezone = input.timezone.trim();
    if (!isValidIanaTimezone(timezone)) {
      throw new SettingsError("时区必须是合法的 IANA 时区，例如 Asia/Shanghai", "invalid_timezone");
    }
    patch.timezone = timezone;
  }
  if (Object.keys(patch).length === 0) {
    throw new SettingsError("没有可更新的字段", "invalid_body");
  }
  const [updated] = await db.update(projects).set(patch).where(eq(projects.id, projectId)).returning();
  if (!updated) throw new SettingsError("项目不存在", "not_found");
  return updated;
}

export async function listProjectKeys(db: Database, projectId: string): Promise<ProjectKeyRow[]> {
  return db
    .select({
      id: projectKeys.id,
      key: projectKeys.key,
      label: projectKeys.label,
      status: projectKeys.status,
      createdAt: projectKeys.createdAt,
      lastUsedAt: projectKeys.lastUsedAt,
      deprecatedAt: projectKeys.deprecatedAt,
      revokedAt: projectKeys.revokedAt,
    })
    .from(projectKeys)
    .where(eq(projectKeys.projectId, projectId))
    .orderBy(projectKeys.createdAt);
}

export async function createProjectKey(db: Database, projectId: string, label?: string | null) {
  let normalizedLabel: string | null = null;
  if (label !== undefined && label !== null) {
    const trimmed = label.trim();
    if (trimmed.length > MAX_KEY_LABEL_LENGTH) {
      throw new SettingsError("Key 标签最多 80 个字符", "invalid_label");
    }
    normalizedLabel = trimmed.length > 0 ? trimmed : null;
  }
  const [row] = await db
    .insert(projectKeys)
    .values({
      projectId,
      key: generateClientKey(),
      label: normalizedLabel,
      status: "active",
    })
    .returning();
  return row!;
}

export async function updateProjectKeyStatus(
  db: Database,
  projectId: string,
  keyId: string,
  status: "deprecated" | "revoked",
  now = new Date(),
) {
  const [keyRow] = await db
    .select()
    .from(projectKeys)
    .where(and(eq(projectKeys.id, keyId), eq(projectKeys.projectId, projectId)))
    .limit(1);
  if (!keyRow) throw new SettingsError("Key 不存在", "not_found");

  if (status === "deprecated") {
    if (keyRow.status !== "active") {
      throw new SettingsError("只能把 active Key 标记为 deprecated", "invalid_transition");
    }
    const [updated] = await db
      .update(projectKeys)
      .set({ status: "deprecated", deprecatedAt: now })
      .where(eq(projectKeys.id, keyId))
      .returning();
    return updated!;
  }

  if (keyRow.status !== "deprecated") {
    throw new SettingsError("只能撤销 deprecated Key（active → deprecated → revoked）", "invalid_transition");
  }

  const [activeCount] = await db
    .select({ value: count() })
    .from(projectKeys)
    .where(and(eq(projectKeys.projectId, projectId), eq(projectKeys.status, "active")));
  if (Number(activeCount?.value ?? 0) < 1) {
    throw new SettingsError("不能撤销最后一把 active Key：请先新建一把 active Key", "last_active_key");
  }

  const [updated] = await db
    .update(projectKeys)
    .set({ status: "revoked", revokedAt: now })
    .where(eq(projectKeys.id, keyId))
    .returning();
  return updated!;
}

export async function deleteAnonymousUserData(db: Database, projectId: string, anonymousUserId: string) {
  const userId = anonymousUserId.trim();
  if (!userId) throw new SettingsError("请填写 anonymous_user_id", "invalid_user");

  return db.transaction(async (tx) => {
    const deletedEvents = await tx
      .delete(events)
      .where(and(eq(events.projectId, projectId), eq(events.anonymousUserId, userId)))
      .returning({ id: events.id });
    const deletedFeedback = await tx
      .delete(feedback)
      .where(and(eq(feedback.projectId, projectId), eq(feedback.anonymousUserId, userId)))
      .returning({ id: feedback.id });
    return {
      deletedEvents: deletedEvents.length,
      deletedFeedback: deletedFeedback.length,
    };
  });
}

export async function clearProjectData(db: Database, projectId: string) {
  return db.transaction(async (tx) => {
    const deletedEvents = await tx.delete(events).where(eq(events.projectId, projectId)).returning({ id: events.id });
    const deletedFeedback = await tx
      .delete(feedback)
      .where(eq(feedback.projectId, projectId))
      .returning({ id: feedback.id });
    const deletedReports = await tx
      .delete(aiReports)
      .where(eq(aiReports.projectId, projectId))
      .returning({ id: aiReports.id });
    return {
      deletedEvents: deletedEvents.length,
      deletedFeedback: deletedFeedback.length,
      deletedReports: deletedReports.length,
    };
  });
}
