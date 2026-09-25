import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { feedback, projectKeys } from "@/db/schema";
import { MAX_BODY_BYTES } from "@/lib/ingest-events";
import { redactComment } from "@/lib/redact-comment";

const KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const PAST_SKEW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COMMENT_CHARS = 300;
const MAX_LABEL_CHARS = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_CODE_PATTERN = /^[a-z_]{2,40}$/;

export type FeedbackIngestResult =
  | { status: 200; body: { accepted: true } }
  | { status: 400; body: { error_code: string } }
  | { status: 401; body: { error_code: "key_revoked" | "key_invalid" } }
  | { status: 413; body: { error_code: "payload_too_large" } };

type ParsedFeedback = {
  feedbackId: string;
  anonymousUserId: string;
  paywallSessionId: string;
  reasonCode: string;
  reasonLabel: string | null;
  comment: string | null;
  platform: "ios" | "android";
  appVersion: string;
  paywallVersion: string | null;
  sdkVersion: string | null;
  occurredAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function charLength(value: string) {
  return Array.from(value).length;
}

export async function readFeedbackRequest(request: Request): Promise<
  { ok: true; body: unknown } | { ok: false; status: 400 | 413; errorCode: string }
> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, errorCode: "payload_too_large" };
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, status: 413, errorCode: "payload_too_large" };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, errorCode: "invalid_json" };
  }
}

function parseFeedback(raw: unknown, receivedAt: Date): { ok: true; feedback: ParsedFeedback } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "invalid_feedback" };
  if (typeof raw.feedback_id !== "string" || !UUID_PATTERN.test(raw.feedback_id)) {
    return { ok: false, error: "invalid_feedback_id" };
  }
  if (typeof raw.paywall_session_id !== "string" || !UUID_PATTERN.test(raw.paywall_session_id)) {
    return { ok: false, error: "invalid_session_id" };
  }
  if (typeof raw.anonymous_user_id !== "string") return { ok: false, error: "invalid_anonymous_user_id" };
  const anonymousUserId = raw.anonymous_user_id.trim();
  if (!anonymousUserId || anonymousUserId.length > 64) return { ok: false, error: "invalid_anonymous_user_id" };
  if (typeof raw.reason_code !== "string" || !REASON_CODE_PATTERN.test(raw.reason_code)) {
    return { ok: false, error: "invalid_reason_code" };
  }
  if (raw.platform !== "ios" && raw.platform !== "android") return { ok: false, error: "invalid_platform" };
  if (typeof raw.app_version !== "string") return { ok: false, error: "invalid_app_version" };
  const appVersion = raw.app_version.trim();
  if (!appVersion || appVersion.length > 32) return { ok: false, error: "invalid_app_version" };

  let reasonLabel: string | null = null;
  if (raw.reason_label !== undefined && raw.reason_label !== null) {
    if (typeof raw.reason_label !== "string") return { ok: false, error: "invalid_reason_label" };
    reasonLabel = raw.reason_label.trim();
    if (!reasonLabel || charLength(reasonLabel) > MAX_LABEL_CHARS) return { ok: false, error: "invalid_reason_label" };
  }

  let comment: string | null = null;
  if (raw.comment !== undefined && raw.comment !== null) {
    if (typeof raw.comment !== "string") return { ok: false, error: "invalid_comment" };
    const trimmed = raw.comment.trim();
    if (trimmed) {
      if (charLength(trimmed) > MAX_COMMENT_CHARS) return { ok: false, error: "comment_too_long" };
      comment = redactComment(trimmed);
    }
  }

  let paywallVersion: string | null = null;
  if (raw.paywall_version !== undefined && raw.paywall_version !== null) {
    if (typeof raw.paywall_version !== "string") return { ok: false, error: "invalid_paywall_version" };
    paywallVersion = raw.paywall_version.trim();
    if (!paywallVersion || paywallVersion.length > 64) return { ok: false, error: "invalid_paywall_version" };
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
  const future = occurredAt.getTime() - receivedAt.getTime() > FUTURE_SKEW_MS;
  const stale = receivedAt.getTime() - occurredAt.getTime() > PAST_SKEW_MS;

  return {
    ok: true,
    feedback: {
      feedbackId: raw.feedback_id,
      anonymousUserId,
      paywallSessionId: raw.paywall_session_id,
      reasonCode: raw.reason_code,
      reasonLabel,
      comment,
      platform: raw.platform,
      appVersion,
      paywallVersion,
      sdkVersion,
      occurredAt: future || stale ? receivedAt : occurredAt,
    },
  };
}

export async function ingestFeedback(
  db: Database,
  clientKey: string,
  raw: unknown,
  receivedAt: Date,
): Promise<FeedbackIngestResult> {
  const [keyRow] = await db.select().from(projectKeys).where(eq(projectKeys.key, clientKey)).limit(1);
  if (!keyRow) return { status: 401, body: { error_code: "key_invalid" } };
  if (keyRow.status === "revoked") return { status: 401, body: { error_code: "key_revoked" } };
  if (keyRow.status !== "active" && keyRow.status !== "deprecated") {
    return { status: 401, body: { error_code: "key_invalid" } };
  }

  const parsed = parseFeedback(raw, receivedAt);
  if (!parsed.ok) return { status: 400, body: { error_code: parsed.error } };

  const row = parsed.feedback;
  await db.transaction(async (tx) => {
    await tx
      .insert(feedback)
      .values({
        projectId: keyRow.projectId,
        feedbackId: row.feedbackId,
        anonymousUserId: row.anonymousUserId,
        paywallSessionId: row.paywallSessionId,
        reasonCode: row.reasonCode,
        reasonLabel: row.reasonLabel,
        comment: row.comment,
        platform: row.platform,
        appVersion: row.appVersion,
        paywallVersion: row.paywallVersion,
        sdkVersion: row.sdkVersion,
        occurredAt: row.occurredAt,
        receivedAt,
      })
      .onConflictDoNothing({ target: [feedback.projectId, feedback.feedbackId] });
    const lastUsed = keyRow.lastUsedAt?.getTime() ?? 0;
    if (receivedAt.getTime() - lastUsed > KEY_TOUCH_INTERVAL_MS) {
      await tx.update(projectKeys).set({ lastUsedAt: receivedAt }).where(eq(projectKeys.id, keyRow.id));
    }
  });
  return { status: 200, body: { accepted: true } };
}
