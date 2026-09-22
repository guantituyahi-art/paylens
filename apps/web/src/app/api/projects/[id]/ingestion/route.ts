import { getDb } from "@/db/client";
import { getSignedInUser } from "@/lib/auth";
import { getIngestionHealth, getOwnedProject } from "@/lib/ingestion-health";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getSignedInUser();
  if (!user) return Response.json({ error_code: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const db = getDb();
    const project = await getOwnedProject(db, id, user.id);
    if (!project) return Response.json({ error_code: "not_found" }, { status: 404 });
    return Response.json(await getIngestionHealth(db, project.id));
  } catch (error) {
    console.error("GET ingestion health failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
