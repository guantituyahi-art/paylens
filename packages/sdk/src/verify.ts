import assert from "node:assert/strict";
import { createPayLens, type KeyValueStorage } from "./index";
import { shouldAskComment } from "./survey";
import { resolveAppVersion } from "./version";

assert.equal(resolveAppVersion("1.0.1", () => "9.9.9"), "1.0.1");
assert.equal(resolveAppVersion(undefined, () => "2.4.0"), "2.4.0");
assert.equal(resolveAppVersion("  ", () => null), "unknown");

function memoryStorage(): KeyValueStorage & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    async getItem(key) {
      return dump.get(key) ?? null;
    },
    async setItem(key, value) {
      dump.set(key, value);
    },
  };
}

function response(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
let idCursor = 0;

function createClient(fetchImpl: typeof fetch) {
  return createPayLens({
    storage: memoryStorage(),
    fetch: fetchImpl,
    now: () => new Date("2026-09-22T08:00:00.000Z"),
    createId: () => ids[idCursor++] ?? `33333333-3333-4333-8333-${String(idCursor).padStart(12, "0")}`,
    readAppVersion: () => "9.9.9",
    platform: "ios",
    autoFlush: false,
  });
}

const sent: unknown[][] = [];
const client = createClient(async (_input, init) => {
  sent.push(JSON.parse(String(init?.body)) as unknown[]);
  return response(200, { accepted: 4, rejected: [] });
});
client.init({ clientKey: "pl_pub_demo", paywallVersion: "A" });
client.track("paywall_viewed");
client.track("subscribe_clicked", { productId: "pro_monthly" });
client.track("paywall_closed");
client.track("purchase_success", { productId: "pro_monthly" });
await client.flush();
const firstBatch = (sent[0] as { events: { paywall_session_id: string; app_version: string; event_name: string }[] }).events;
assert.equal(firstBatch.length, 4);
assert.equal(new Set(firstBatch.map((event) => event.paywall_session_id)).size, 1);
assert.equal(firstBatch[0]?.app_version, "9.9.9");
assert.deepEqual(
  firstBatch.map((event) => event.event_name),
  ["paywall_viewed", "subscribe_clicked", "paywall_closed", "purchase_success"],
);
assert.equal(client.debugState().queue.length, 0);
client.stop();
console.log("ok sdk session and app version");

let networkUp = false;
const offline = createPayLens({
  storage: memoryStorage(),
  fetch: async () => {
    if (!networkUp) throw new Error("offline");
    return response(200, { accepted: 1, rejected: [] });
  },
  now: () => new Date("2026-09-22T08:00:00.000Z"),
  createId: () => "44444444-4444-4444-8444-444444444444",
  readAppVersion: () => "1.0.0",
  platform: "android",
  autoFlush: false,
});
offline.init({ clientKey: "pl_pub_offline" });
offline.track("paywall_viewed");
await offline.flush();
assert.equal(offline.debugState().queue.length, 1);
networkUp = true;
await offline.flush();
assert.equal(offline.debugState().queue.length, 0);
offline.stop();
console.log("ok sdk offline replay");

let calls = 0;
const retry = createPayLens({
  storage: memoryStorage(),
  fetch: async () => {
    calls += 1;
    if (calls === 1) return response(500, { error_code: "server_error" });
    if (calls === 2) return response(429, { error_code: "quota_exceeded" }, { "retry-after": "60" });
    if (calls === 3) return response(401, { error_code: "key_revoked" });
    return response(200, { accepted: 1, rejected: [] });
  },
  now: () => new Date("2026-09-22T08:00:00.000Z"),
  createId: () => "55555555-5555-4555-8555-555555555555",
  readAppVersion: () => "1.0.0",
  platform: "ios",
  autoFlush: false,
});
retry.init({ clientKey: "pl_pub_retry" });
retry.track("paywall_viewed");
await retry.flush();
assert.equal(retry.debugState().queue.length, 1);
assert.equal(retry.debugState().pausedKey, null);
await retry.flush();
assert.equal(retry.debugState().queue.length, 1);
assert.equal(retry.debugState().pausedKey, null);
await retry.flush();
assert.equal(retry.debugState().pausedKey, "pl_pub_retry");
assert.equal(retry.debugState().queue.length, 1);
const callsAfterRevoke = calls;
await retry.flush();
assert.equal(calls, callsAfterRevoke);
retry.init({ clientKey: "pl_pub_new" });
await retry.flush();
assert.equal(retry.debugState().queue.length, 0);
assert.equal(calls, callsAfterRevoke + 1);
retry.stop();
console.log("ok sdk retry policy");

assert.equal(shouldAskComment("other", true), true);
assert.equal(shouldAskComment("too_expensive", true), false);
assert.equal(shouldAskComment("other", false), false);

const surveyClock = { value: new Date("2026-09-22T08:00:00.000Z") };
const surveySent: unknown[] = [];
const surveyClient = createPayLens({
  storage: memoryStorage(),
  fetch: async (input, init) => {
    surveySent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return response(200, { accepted: true });
  },
  now: () => surveyClock.value,
  createId: () => "66666666-6666-4666-8666-666666666666",
  readAppVersion: () => "1.0.0",
  platform: "ios",
  autoFlush: false,
});
surveyClient.init({ clientKey: "pl_pub_survey", paywallVersion: "A" });
await surveyClient.flush();
surveyClient.track("paywall_viewed");
assert.equal(surveyClient.shouldShowExitSurvey(), false);
surveyClient.track("paywall_closed");
assert.equal(surveyClient.shouldShowExitSurvey(), true);
surveyClient.markExitSurveyShown();
surveyClient.track("paywall_viewed");
surveyClient.track("paywall_closed");
assert.equal(surveyClient.shouldShowExitSurvey(), false);
surveyClock.value = new Date("2026-09-29T08:00:00.000Z");
assert.equal(surveyClient.shouldShowExitSurvey(), true);

const purchased = createPayLens({
  storage: memoryStorage(),
  fetch: async () => response(200, { accepted: true }),
  now: () => new Date("2026-09-22T08:00:00.000Z"),
  createId: () => "77777777-7777-4777-8777-777777777777",
  readAppVersion: () => "1.0.0",
  platform: "ios",
  autoFlush: false,
});
purchased.init({ clientKey: "pl_pub_purchased" });
await purchased.flush();
purchased.track("paywall_viewed");
purchased.track("purchase_success", { productId: "pro_monthly" });
purchased.track("paywall_closed");
assert.equal(purchased.shouldShowExitSurvey(), false);
purchased.stop();

surveyClient.submitFeedback("other", { label: "其他", comment: "还没用过导出" });
await surveyClient.flush();
const feedbackCall = surveySent.find((item) => (item as { url: string }).url.endsWith("/feedback")) as {
  body: { reason_code: string; comment: string; paywall_session_id: string };
};
assert.equal(feedbackCall.body.reason_code, "other");
assert.equal(feedbackCall.body.comment, "还没用过导出");
assert.equal(surveyClient.debugState().feedbackQueue.length, 0);
surveyClient.stop();
console.log("ok sdk exit survey");
