import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getFeedbackSummary } from "@/lib/feedback-stats";
import { getOwnedProject } from "@/lib/ingestion-health";
import { parseDashboardQuery } from "@/lib/period";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const url = new URL(request.url);
    const parsed = parseDashboardQuery(project.timezone, {
      range: url.searchParams.get("range"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      app_version: url.searchParams.get("app_version"),
      paywall_version: url.searchParams.get("paywall_version"),
    });
    if (!parsed.ok) return Response.json({ error_code: "invalid_range" }, { status: 400 });
    return Response.json(await getFeedbackSummary(db, project, { ...parsed.query, period: parsed.query.period }));
  } catch (error) {
    console.error("GET feedback summary failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
