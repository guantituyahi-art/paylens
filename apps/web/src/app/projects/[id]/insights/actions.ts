"use server";

import { redirect } from "next/navigation";
import { getDatabaseUrl, getDb } from "@/db/client";
import { createAiProviderFromEnv } from "@/lib/ai-provider";
import { requireUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { ensureDeveloperRecord } from "@/lib/projects";
import { generateReport, readReportRequest } from "@/lib/reports";

export async function generateReportAction(formData: FormData) {
  const projectId = String(formData.get("project_id") ?? "");
  const parsed = readReportRequest({
    period: formData.get("period"),
    appVersion: formData.get("app_version"),
    paywallVersion: formData.get("paywall_version"),
  });
  const back = `/projects/${projectId}/insights`;
  if (!parsed.ok) redirect(`${back}?error=${encodeURIComponent(parsed.message)}`);

  const developer = await requireUser();
  if (!getDatabaseUrl()) redirect(`${back}?error=${encodeURIComponent("缺少 DATABASE_URL。")}`);

  const db = getDb();
  await ensureDeveloperRecord(db, developer);
  const project = await getOwnedProject(db, projectId, developer.id);
  if (!project) redirect("/projects");

  const report = await generateReport(db, project, {
    periodKind: parsed.periodKind,
    appVersion: parsed.appVersion,
    paywallVersion: parsed.paywallVersion,
    now: new Date(),
    provider: createAiProviderFromEnv(),
  });
  const params = new URLSearchParams({ period: parsed.periodKind, report: report.id });
  if (parsed.appVersion) params.set("app_version", parsed.appVersion);
  if (parsed.paywallVersion) params.set("paywall_version", parsed.paywallVersion);
  redirect(`${back}?${params.toString()}`);
}
