import { MAX_BODY_BYTES, MAX_EVENTS_PER_REQUEST } from "@/lib/ingest-events";

export type EventsRequestResult =
  | { ok: true; events: unknown[] }
  | { ok: false; status: 400 | 413; errorCode: string };

export async function readEventsRequest(request: Request): Promise<EventsRequestResult> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, errorCode: "payload_too_large" };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, errorCode: "payload_too_large" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, errorCode: "invalid_json" };
  }
  if (typeof body !== "object" || body === null || !Array.isArray((body as { events?: unknown }).events)) {
    return { ok: false, status: 400, errorCode: "invalid_body" };
  }
  const events = (body as { events: unknown[] }).events;
  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return { ok: false, status: 400, errorCode: "too_many_events" };
  }
  return { ok: true, events };
}

export function readClientKey(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const key = header.slice("Bearer ".length).trim();
  return key.length > 0 ? key : null;
}
