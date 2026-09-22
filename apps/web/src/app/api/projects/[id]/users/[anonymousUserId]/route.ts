import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { deleteAnonymousUserData, SettingsError } from "@/lib/project-settings";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string; anonymousUserId: string }> },
) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id, anonymousUserId } = await context.params;
  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const result = await deleteAnonymousUserData(db, project.id, decodeURIComponent(anonymousUserId));
    return Response.json({
      deleted_events: result.deletedEvents,
      deleted_feedback: result.deletedFeedback,
    });
  } catch (error) {
    if (error instanceof SettingsError) {
      return Response.json({ error_code: error.code, message: error.message }, { status: 400 });
    }
    console.error("DELETE user data failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
