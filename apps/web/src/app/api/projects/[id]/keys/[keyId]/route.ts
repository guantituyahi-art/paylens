import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { SettingsError, updateProjectKeyStatus } from "@/lib/project-settings";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string; keyId: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id, keyId } = await context.params;
  let body: { status?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error_code: "invalid_body" }, { status: 400 });
  }
  if (body.status !== "deprecated" && body.status !== "revoked") {
    return Response.json({ error_code: "invalid_status" }, { status: 400 });
  }

  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const updated = await updateProjectKeyStatus(db, project.id, keyId, body.status);
    return Response.json({
      id: updated.id,
      key: updated.key,
      label: updated.label,
      status: updated.status,
      created_at: updated.createdAt.toISOString(),
      last_used_at: updated.lastUsedAt?.toISOString() ?? null,
      deprecated_at: updated.deprecatedAt?.toISOString() ?? null,
      revoked_at: updated.revokedAt?.toISOString() ?? null,
    });
  } catch (error) {
    if (error instanceof SettingsError) {
      const status = error.code === "not_found" ? 404 : error.code === "last_active_key" ? 409 : 400;
      return Response.json({ error_code: error.code, message: error.message }, { status });
    }
    console.error("PATCH key failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
