import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { events, projectDailyUsage, projectKeys } from "@/db/schema";

export const DAILY_EVENT_LIMIT = 100_000;
export const MAX_EVENTS_PER_REQUEST = 50;
export const MAX_BODY_BYTES = 64 * 1024;
const KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const PAST_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

export const EVENT_NAMES = [
  "paywall_viewed",
  "subscribe_clicked",
  "purchase_success",
  "paywall_closed",
  "purchase_failed",
] as const;

export const FAILURE_KINDS = ["user_cancelled", "payment_error", "unknown"] as const;

const PRODUCT_EVENTS = new Set(["subscribe_clicked", "purchase_success", "purchase_failed"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IngestRejection = { index: number; error: string };

export type IngestResult =
  | { status: 200; body: { accepted: number; rejected: IngestRejection[] } }
  | { status: 401; body: { error_code: "key_revoked" | "key_invalid" } }
  | { status: 429; body: { error_code: "quota_exceeded" } };

type ParsedEvent = {
  eventId: string;
  anonymousUserId: string;
  paywallSessionId: string;
  eventName: (typeof EVENT_NAMES)[number];
  platform: "ios" | "android";
  appVersion: string;
  paywallVersion: string | null;
  productId: string | null;
  failureKind: (typeof FAILURE_KINDS)[number] | null;
  sdkVersion: string | null;
  occurredAt: Date;
};

class QuotaExceededError extends Error {
  constructor() {
    super("quota_exceeded");
    this.name = "QuotaExceededError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvent(raw: unknown, receivedAt: Date): { ok: true; event: ParsedEvent } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "invalid_event" };
  const eventName = raw.event_name;
  if (typeof eventName !== "string" || !EVENT_NAMES.includes(eventName as (typeof EVENT_NAMES)[number])) {
    return { ok: false, error: "unknown_event_name" };
  }
  if (typeof raw.event_id !== "string" || !UUID_PATTERN.test(raw.event_id)) {
    return { ok: false, error: "invalid_event_id" };
  }
  if (typeof raw.paywall_session_id !== "string" || !UUID_PATTERN.test(raw.paywall_session_id)) {
    return { ok: false, error: "invalid_session_id" };
  }
  if (typeof raw.anonymous_user_id !== "string") return { ok: false, error: "invalid_anonymous_user_id" };
  const anonymousUserId = raw.anonymous_user_id.trim();
  if (!anonymousUserId || anonymousUserId.length > 64) return { ok: false, error: "invalid_anonymous_user_id" };
  if (raw.platform !== "ios" && raw.platform !== "android") return { ok: false, error: "invalid_platform" };
  if (typeof raw.app_version !== "string") return { ok: false, error: "invalid_app_version" };
  const appVersion = raw.app_version.trim();
  if (!appVersion || appVersion.length > 32) return { ok: false, error: "invalid_app_version" };

  let paywallVersion: string | null = null;
  if (raw.paywall_version !== undefined && raw.paywall_version !== null) {
    if (typeof raw.paywall_version !== "string") return { ok: false, error: "invalid_paywall_version" };
    paywallVersion = raw.paywall_version.trim();
    if (!paywallVersion || paywallVersion.length > 64) return { ok: false, error: "invalid_paywall_version" };
  }

  let productId: string | null = null;
  if (raw.product_id !== undefined && raw.product_id !== null) {
    if (!PRODUCT_EVENTS.has(eventName)) return { ok: false, error: "product_id_not_allowed" };
    if (typeof raw.product_id !== "string") return { ok: false, error: "invalid_product_id" };
    productId = raw.product_id.trim();
    if (!productId || productId.length > 128) return { ok: false, error: "invalid_product_id" };
  }

  let failureKind: ParsedEvent["failureKind"] = null;
  if (eventName === "purchase_failed") {
    if (typeof raw.failure_kind !== "string" || !FAILURE_KINDS.includes(raw.failure_kind as ParsedEvent["failureKind"] & string)) {
      return { ok: false, error: "invalid_failure_kind" };
    }
    failureKind = raw.failure_kind as ParsedEvent["failureKind"];
  } else if (raw.failure_kind !== undefined && raw.failure_kind !== null) {
    return { ok: false, error: "invalid_failure_kind" };
  }

  let sdkVersion: string | null = null;
  if (raw.sdk_version !== undefined && raw.sdk_version !== null) {
    if (typeof raw.sdk_version !== "string") return { ok: false, error: "invalid_sdk_version" };
    sdkVersion = raw.sdk_version.trim();
    if (!sdkVersion || sdkVersion.length > 32) return { ok: false, error: "invalid_sdk_version" };
  }

  if (typeof raw.occurred_at !== "string") return { ok: false, error: "invalid_occurred_at" };
  const occurredAt = new Date(raw.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, error: "invalid_occurred_at" };
  const skew = occurredAt.getTime() - receivedAt.getTime();
  const clamped = skew > FUTURE_SKEW_MS || receivedAt.getTime() - occurredAt.getTime() > PAST_SKEW_MS;

  return {
    ok: true,
    event: {
      eventId: raw.event_id,
      anonymousUserId,
      paywallSessionId: raw.paywall_session_id,
      eventName: eventName as ParsedEvent["eventName"],
      platform: raw.platform,
      appVersion,
      paywallVersion,
      productId,
      failureKind,
      sdkVersion,
      occurredAt: clamped ? receivedAt : occurredAt,
    },
  };
}

function utcDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

export async function ingestEvents(
  db: Database,
  clientKey: string,
  rawEvents: unknown[],
  receivedAt: Date,
  options?: { dailyLimit?: number },
): Promise<IngestResult> {
  const limit = options?.dailyLimit ?? DAILY_EVENT_LIMIT;
  const [keyRow] = await db.select().from(projectKeys).where(eq(projectKeys.key, clientKey)).limit(1);
  if (!keyRow) return { status: 401, body: { error_code: "key_invalid" } };
  if (keyRow.status === "revoked") return { status: 401, body: { error_code: "key_revoked" } };
  if (keyRow.status !== "active" && keyRow.status !== "deprecated") {
    return { status: 401, body: { error_code: "key_invalid" } };
  }

  const rejected: IngestRejection[] = [];
  const valid: { event: ParsedEvent }[] = [];
  const seenEventIds = new Set<string>();
  let duplicateCount = 0;
  rawEvents.forEach((raw, index) => {
    const parsed = parseEvent(raw, receivedAt);
    if (!parsed.ok) {
      rejected.push({ index, error: parsed.error });
      return;
    }
    if (seenEventIds.has(parsed.event.eventId)) {
      duplicateCount += 1;
      return;
    }
    seenEventIds.add(parsed.event.eventId);
    valid.push({ event: parsed.event });
  });

  const day = utcDay(receivedAt);
  try {
    const accepted = await db.transaction(async (tx) => {
      await tx
        .insert(projectDailyUsage)
        .values({ projectId: keyRow.projectId, day, eventCount: 0 })
        .onConflictDoNothing();
      await tx.execute(
        sql`select event_count from project_daily_usage where project_id = ${keyRow.projectId} and day = cast(${day} as date) for update`,
      );
      const [usage] = await tx
        .select()
        .from(projectDailyUsage)
        .where(and(eq(projectDailyUsage.projectId, keyRow.projectId), eq(projectDailyUsage.day, day)));
      const inserted =
        valid.length === 0
          ? []
          : await tx
              .insert(events)
              .values(
                valid.map(({ event }) => ({
                  projectId: keyRow.projectId,
                  eventId: event.eventId,
                  anonymousUserId: event.anonymousUserId,
                  paywallSessionId: event.paywallSessionId,
                  eventName: event.eventName,
                  platform: event.platform,
                  appVersion: event.appVersion,
                  paywallVersion: event.paywallVersion,
                  productId: event.productId,
                  failureKind: event.failureKind,
                  sdkVersion: event.sdkVersion,
                  occurredAt: event.occurredAt,
                  receivedAt,
                })),
              )
              .onConflictDoNothing({ target: [events.projectId, events.eventId] })
              .returning({ id: events.id });
      const current = usage?.eventCount ?? 0;
      if (current + inserted.length > limit) throw new QuotaExceededError();
      if (inserted.length > 0) {
        await tx
          .update(projectDailyUsage)
          .set({ eventCount: current + inserted.length })
          .where(and(eq(projectDailyUsage.projectId, keyRow.projectId), eq(projectDailyUsage.day, day)));
      }
      const lastUsed = keyRow.lastUsedAt?.getTime() ?? 0;
      if (receivedAt.getTime() - lastUsed > KEY_TOUCH_INTERVAL_MS) {
        await tx.update(projectKeys).set({ lastUsedAt: receivedAt }).where(eq(projectKeys.id, keyRow.id));
      }
      return valid.length + duplicateCount;
    });
    return { status: 200, body: { accepted, rejected } };
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return { status: 429, body: { error_code: "quota_exceeded" } };
    }
    throw error;
  }
}
