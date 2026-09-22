import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { clearProjectData } from "@/lib/project-settings";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const result = await clearProjectData(db, project.id);
    return Response.json({
      deleted_events: result.deletedEvents,
      deleted_feedback: result.deletedFeedback,
      deleted_reports: result.deletedReports,
    });
  } catch (error) {
    console.error("DELETE project data failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
