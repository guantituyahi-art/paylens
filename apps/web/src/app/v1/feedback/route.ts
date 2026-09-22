import { getDb } from "@/db/client";
import { readClientKey } from "@/lib/events-request";
import { ingestFeedback, readFeedbackRequest } from "@/lib/ingest-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const parsed = await readFeedbackRequest(request);
  if (!parsed.ok) return Response.json({ error_code: parsed.errorCode }, { status: parsed.status });
  const clientKey = readClientKey(request);
  if (!clientKey) return Response.json({ error_code: "key_invalid" }, { status: 401 });
  try {
    const result = await ingestFeedback(getDb(), clientKey, parsed.body, new Date());
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    console.error("POST /v1/feedback failed");
    console.error(error instanceof Error ? error.name : "unknown");
    return Response.json({ error_code: "server_error" }, { status: 500 });
  }
}
