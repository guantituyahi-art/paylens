import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { createProjectKey, listProjectKeys, SettingsError } from "@/lib/project-settings";

export const dynamic = "force-dynamic";

function keyJson(row: Awaited<ReturnType<typeof listProjectKeys>>[number]) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    deprecated_at: row.deprecatedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
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
    const keys = await listProjectKeys(db, project.id);
    return Response.json({ keys: keys.map(keyJson) });
  } catch (error) {
    console.error("GET keys failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });

  const { id } = await context.params;
  let body: { label?: unknown } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return Response.json({ error_code: "invalid_body" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label : body.label === null ? null : undefined;

  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    const created = await createProjectKey(db, project.id, label);
    return Response.json(keyJson(created), { status: 201 });
  } catch (error) {
    if (error instanceof SettingsError) {
      return Response.json({ error_code: error.code, message: error.message }, { status: 400 });
    }
    console.error("POST keys failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
