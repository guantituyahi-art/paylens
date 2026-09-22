"use server";

import { redirect } from "next/navigation";
import { getDatabaseUrl, getDb } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { ensureDeveloperRecord } from "@/lib/projects";
import {
  clearProjectData,
  createProjectKey,
  deleteAnonymousUserData,
  SettingsError,
  updateProjectKeyStatus,
  updateProjectSettings,
} from "@/lib/project-settings";

function settingsPath(projectId: string, query?: Record<string, string>) {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  return qs ? `/projects/${projectId}/settings?${qs}` : `/projects/${projectId}/settings`;
}

async function requireOwnedProject(projectId: string) {
  const developer = await requireUser();
  if (!getDatabaseUrl()) redirect(settingsPath(projectId, { error: "缺少 DATABASE_URL。" }));
  const db = getDb();
  await ensureDeveloperRecord(db, developer);
  const project = await getOwnedProject(db, projectId, developer.id);
  if (!project) redirect("/projects");
  return { db, project };
}

export async function updateTimezoneAction(formData: FormData) {
  const projectId = String(formData.get("project_id") ?? "");
  const timezone = String(formData.get("timezone") ?? "");
  try {
    const { db, project } = await requireOwnedProject(projectId);
    await updateProjectSettings(db, project.id, { timezone });
  } catch (error) {
    if (error instanceof SettingsError) {
      redirect(settingsPath(projectId, { error: error.message }));
    }
    throw error;
  }
  redirect(settingsPath(projectId, { saved: "timezone" }));
}

export async function createKeyAction(formData: FormData) {
  const projectId = String(formData.get("project_id") ?? "");
  const label = String(formData.get("label") ?? "");
  try {
    const { db, project } = await requireOwnedProject(projectId);
    await createProjectKey(db, project.id, label);
  } catch (error) {
    if (error instanceof SettingsError) {
      redirect(settingsPath(projectId, { error: error.message }));
    }
    throw error;
  }
  redirect(settingsPath(projectId, { saved: "key_created" }));
}

export async function deprecateKeyAction(formData: FormData) {
  const projectId = String(formData.get("project_id") ?? "");
  const keyId = String(formData.get("key_id") ?? "");
  try {
    const { db, project } = await requireOwnedProject(projectId);
    await updateProjectKeyStatus(db, project.id, keyId, "deprecated");
  } catch (error) {
    if (error instanceof SettingsError) {
      redirect(settingsPath(projectId, { error: error.message }));
    }
    throw error;
  }
  redirect(settingsPath(projectId, { saved: "key_deprecated" }));
}

export async function revokeKeyAction(formData: FormData) {
  const projectId = String(formData.get("project_id") ?? "");
  const keyId = String(formData.get("key_id") ?? "");
  try {
    const { db, project } = await requireOwnedProject(projectId);
    await updateProjectKeyStatus(db, project.id, keyId, "revoked");
  } catch (error) {
    if (error instanceof SettingsError) {
      redirect(settingsPath(projectId, { error: error.message }));
    }
    throw error;
  }
  redirect(settingsPath(projectId, { saved: "key_revoked" }));
}

export async function deleteUserDataAction(formData: FormData) {
  const projectId = String(formData.get("project_id") ?? "");
  const anonymousUserId = String(formData.get("anonymous_user_id") ?? "");
  let result: { deletedEvents: number; deletedFeedback: number };
  try {
    const { db, project } = await requireOwnedProject(projectId);
    result = await deleteAnonymousUserData(db, project.id, anonymousUserId);
  } catch (error) {
    if (error instanceof SettingsError) {
      redirect(settingsPath(projectId, { error: error.message }));
    }
    throw error;
  }
  redirect(
    settingsPath(projectId, {
      saved: "user_deleted",
      events: String(result.deletedEvents),
      feedback: String(result.deletedFeedback),
    }),
  );
}

export async function clearProjectDataAction(formData: FormData) {
  const projectId = String(formData.get("project_id") ?? "");
  const confirmName = String(formData.get("confirm_name") ?? "");
  let result: { deletedEvents: number; deletedFeedback: number; deletedReports: number };
  try {
    const { db, project } = await requireOwnedProject(projectId);
    if (confirmName.trim() !== project.name) {
      redirect(settingsPath(projectId, { error: "请输入完整项目名称以确认清空。" }));
    }
    result = await clearProjectData(db, project.id);
  } catch (error) {
    if (error instanceof SettingsError) {
      redirect(settingsPath(projectId, { error: error.message }));
    }
    throw error;
  }
  redirect(
    settingsPath(projectId, {
      saved: "cleared",
      events: String(result.deletedEvents),
      feedback: String(result.deletedFeedback),
      reports: String(result.deletedReports),
    }),
  );
}
