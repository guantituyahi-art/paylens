import { getDb } from "@/db/client";
import { createAiProviderFromEnv } from "@/lib/ai-provider";
import { getSignedInUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { generateReport, listReports, readReportRequest, type StoredReport } from "@/lib/reports";

export const dynamic = "force-dynamic";

function reportJson(report: StoredReport, detail: boolean) {
  return {
    id: report.id,
    status: report.status,
    timezone: report.timezone,
    period_start: report.periodStart,
    period_end: report.periodEnd,
    compare_start: report.compareStart,
    compare_end: report.compareEnd,
    filters: report.filters,
    model: report.model,
    prompt_version: report.promptVersion,
    error: report.error,
    created_at: report.createdAt.toISOString(),
    ...(detail ? { input_snapshot: report.inputSnapshot, output: report.output } : {}),
  };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const reports = await listReports(db, project.id);
    return Response.json({ reports: reports.map((report) => reportJson(report, false)) });
  } catch (error) {
    console.error("GET reports failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  let body: { period?: unknown; filters?: { app_version?: unknown; paywall_version?: unknown } };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error_code: "invalid_body" }, { status: 400 });
  }
  const parsed = readReportRequest({
    period: body.period,
    appVersion: body.filters?.app_version,
    paywallVersion: body.filters?.paywall_version,
  });
  if (!parsed.ok) return Response.json({ error_code: "invalid_report", message: parsed.message }, { status: 400 });

  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const report = await generateReport(db, project, {
      periodKind: parsed.periodKind,
      appVersion: parsed.appVersion,
      paywallVersion: parsed.paywallVersion,
      now: new Date(),
      provider: createAiProviderFromEnv(),
    });
    return Response.json(reportJson(report, true));
  } catch (error) {
    console.error("POST reports failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
