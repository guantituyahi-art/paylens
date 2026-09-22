import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { getReport } from "@/lib/reports";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string; reportId: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id, reportId } = await context.params;
  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const report = await getReport(db, project.id, reportId);
    if (!report) return Response.json({ error_code: "not_found" }, { status: 404 });
    return Response.json({
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
      input_snapshot: report.inputSnapshot,
      output: report.output,
    });
  } catch (error) {
    console.error("GET report failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
