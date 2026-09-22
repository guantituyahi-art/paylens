import { getDb } from "@/db/client";
import { readClientKey, readEventsRequest } from "@/lib/events-request";
import { ingestEvents } from "@/lib/ingest-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = await readEventsRequest(request);
  if (!parsed.ok) {
    return Response.json({ error_code: parsed.errorCode }, { status: parsed.status });
  }
  const clientKey = readClientKey(request);
  if (!clientKey) {
    return Response.json({ error_code: "key_invalid" }, { status: 401 });
  }
  try {
    const result = await ingestEvents(getDb(), clientKey, parsed.events, new Date());
    const headers = new Headers();
    if (result.status === 429) headers.set("Retry-After", "60");
    return Response.json(result.body, { status: result.status, headers });
  } catch (error) {
    console.error("POST /v1/events failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
