import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { SettingsError, updateProjectSettings } from "@/lib/project-settings";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  let body: { name?: unknown; timezone?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error_code: "invalid_body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name : undefined;
  const timezone = typeof body.timezone === "string" ? body.timezone : undefined;
  if (name === undefined && timezone === undefined) {
    return Response.json({ error_code: "invalid_body" }, { status: 400 });
  }

  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const updated = await updateProjectSettings(db, project.id, { name, timezone });
    return Response.json({
      id: updated.id,
      name: updated.name,
      timezone: updated.timezone,
      retention_days: updated.retentionDays,
    });
  } catch (error) {
    if (error instanceof SettingsError) {
      const status = error.code === "not_found" ? 404 : 400;
      return Response.json({ error_code: error.code, message: error.message }, { status });
    }
    console.error("PATCH project failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
