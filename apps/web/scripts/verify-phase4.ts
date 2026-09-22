import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../src/db/client";
import { aiReports, developers, events, feedback, projectKeys, projects } from "../src/db/schema";
import type { AiProvider } from "../src/lib/ai-provider";
import { completeReportPeriod, previousPeriod } from "../src/lib/period";
import { buildFacts, validateInference, type ReportSnapshot } from "../src/lib/report-facts";
import { generateReport } from "../src/lib/reports";

const now = new Date("2026-09-22T04:00:00.000Z");
const reportWindow = completeReportPeriod("Asia/Shanghai", "7d", now);
assert.deepEqual(reportWindow, { from: "2026-09-15", to: "2026-09-21" });
assert.deepEqual(previousPeriod(reportWindow), { from: "2026-09-08", to: "2026-09-14" });
assert.equal(completeReportPeriod("Asia/Shanghai", "30d", now).from, "2026-08-23");

const fixture = {
  timezone: "Asia/Shanghai",
  period: { start: "2026-09-15", end: "2026-09-21", days: 7 },
  compare: { start: "2026-09-08", end: "2026-09-14" },
  filters: { app_version: null, paywall_version: null },
  thresholds: { min_sessions: 100, min_feedback: 20, min_reason_count: 30, met: true },
  funnel: {
    current: { sessions: 200, clicked: 80, purchased: 20, view_to_click: 0.4, click_to_purchase: 0.25, overall: 0.1 },
    previous: {
      sessions: 200,
      clicked: 60,
      purchased: 10,
      view_to_click: 0.3,
      click_to_purchase: 1 / 6,
      overall: 0.05,
    },
    biggest_drop: { step: "view_to_click" as const, lost: 120, lost_rate: 0.6 },
  },
  feedback: {
    total: 40,
    closed_without_purchase: 150,
    response_rate: 40 / 150,
    reasons: [
      {
        code: "too_expensive",
        label: "太贵了",
        count: 40,
        share: 0.5,
        prev_count: 40,
        prev_share: 0.4,
        delta_pp: 10,
        low_sample: false,
      },
      {
        code: "need_time",
        label: "再想想",
        count: 10,
        share: 0.125,
        prev_count: 5,
        prev_share: 0.05,
        delta_pp: 8,
        low_sample: true,
      },
    ],
  },
  comment_themes: [{ theme: "paywall_too_early", count: 4, examples: ["太早了"] }],
  by_product: [
    { product_id: "annual", clicked: 40, purchased: 8 },
    { product_id: "monthly", clicked: 35, purchased: 4 },
    { product_id: "tiny", clicked: 5, purchased: 0 },
  ],
};

const facts = buildFacts(fixture);
assert.deepEqual(facts, buildFacts(fixture));
assert.equal(facts.facts[0]?.text, "整体转化率 10.0%，上期 5.0%，上升 5 个百分点");
assert.equal(facts.facts[1]?.text, "最大流失点：Paywall → 点击订阅，流失 120 次（60.0%）");
assert.ok(facts.facts.some((fact) => fact.text === "看到付费页后点击 40.0%，上期 30.0%，上升 10 个百分点"));
assert.ok(facts.facts.some((fact) => fact.text === "点击订阅后购买 25.0%，上期 16.7%，上升 8.3 个百分点"));
assert.ok(facts.facts.some((fact) => fact.text === "“太贵了”占 50.0%（n=40）"));
assert.ok(facts.facts.some((fact) => fact.text === "“太贵了”占 50.0%（n=40），上期 40.0%，上升 10 个百分点"));
assert.ok(facts.facts.some((fact) => fact.text === "4 条文字反馈归为主题「付费页出现得太早」"));
assert.ok(facts.facts.some((fact) => fact.text === "分产品：annual 点击 40 次、购买 8 次；monthly 点击 35 次、购买 4 次"));
assert.equal(facts.facts.some((fact) => fact.text.includes("再想想")), false);
assert.equal(facts.facts.some((fact) => fact.text.includes("tiny")), false);
assert.deepEqual(facts.facts[0]?.source_keys, ["funnel.current.overall", "funnel.previous.overall"]);

const keyIds = new Set(facts.key_changes);
assert.equal(keyIds.has(facts.facts[0]!.id), true);
assert.equal(keyIds.has(facts.facts.find((fact) => fact.source_keys.includes("funnel.biggest_drop"))!.id), false);
assert.equal(
  keyIds.has(facts.facts.find((fact) => fact.text === "“太贵了”占 50.0%（n=40），上期 40.0%，上升 10 个百分点")!.id),
  true,
);
assert.equal(keyIds.has(facts.facts.find((fact) => fact.source_keys.includes("comment_themes[paywall_too_early]"))!.id), false);
assert.equal(keyIds.has(facts.facts.find((fact) => fact.source_keys.includes("by_product"))!.id), false);
assert.ok(facts.caveats.some((caveat) => caveat.includes("回答率")));

const snapshot: ReportSnapshot = {
  ...fixture,
  ...facts,
  facts: [...facts.facts, { id: "Fx", text: "小样本原因", source_keys: ["feedback.reasons[need_time]"] }],
};
const checked = validateInference(
  {
    hypotheses: [
      { id: "H1", text: "可以延后展示付费页", based_on: ["F1"], confidence: "medium" },
      { id: "Hbad", text: "依据不存在", based_on: ["F99"], confidence: "low" },
      { id: "Hnum", text: "大约有 9999 人", based_on: ["F1"], confidence: "low" },
      { id: "Hlow", text: "价格可能是主要顾虑", based_on: ["Fx"], confidence: "low" },
      { id: "Hcause", text: "因为价格偏高", based_on: ["F1"], confidence: "low" },
    ],
    suggested_tests: [
      { id: "T1", text: "延后展示付费页", for_hypothesis: "H1", measure: "对比两个版本的点击" },
      { id: "Tdrop", text: "无效测试", for_hypothesis: "Hbad", measure: "观察转化" },
    ],
    notes: "大约 9999",
  },
  snapshot,
);
assert.equal(checked.ok, true);
if (checked.ok) {
  assert.deepEqual(
    checked.inference.hypotheses.map((item) => item.id),
    ["H1"],
  );
  assert.deepEqual(
    checked.inference.suggested_tests.map((item) => item.id),
    ["T1"],
  );
  assert.equal(checked.inference.notes, null);
}
assert.equal(
  validateInference(
    {
      hypotheses: [{ id: "H", text: "大约有 9999 人", based_on: ["F99"], confidence: "low" }],
      suggested_tests: [],
      notes: "",
    },
    snapshot,
  ).ok,
  false,
);
const emptyInference = validateInference({ hypotheses: [], suggested_tests: [], notes: "" }, snapshot);
assert.equal(emptyInference.ok, true);

const client = new PGlite();
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
for (const file of ["0000_phase0.sql", "0001_phase1.sql", "0002_phase3.sql", "0003_phase4.sql"]) {
  const statements = readFileSync(join(migrationDir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) await client.exec(statement);
}
const db = drizzle(client, {
  schema: { developers, projects, projectKeys, events, feedback, aiReports },
}) as unknown as Database;

async function createProject(name: string) {
  const developerId = randomUUID();
  await db.insert(developers).values({ id: developerId, email: `${name}@paylens.local` });
  const [project] = await db
    .insert(projects)
    .values({ developerId, name, timezone: "Asia/Shanghai" })
    .returning();
  return { id: project!.id, timezone: "Asia/Shanghai" };
}

async function seedSessions(projectId: string, count: number, feedbackCount: number, commentCount: number) {
  const userId = randomUUID();
  const occurredAt = new Date("2026-09-20T02:00:00.000Z");
  const eventRows = [];
  const feedbackRows = [];
  for (let index = 0; index < count; index += 1) {
    const sessionId = randomUUID();
    const base = {
      projectId,
      anonymousUserId: userId,
      paywallSessionId: sessionId,
      platform: "ios",
      appVersion: "1.0.0",
      paywallVersion: "A",
      occurredAt,
    };
    eventRows.push({ ...base, eventId: randomUUID(), eventName: "paywall_viewed" });
    eventRows.push({ ...base, eventId: randomUUID(), eventName: "paywall_closed" });
    if (index < feedbackCount) {
      feedbackRows.push({
        ...base,
        feedbackId: randomUUID(),
        reasonCode: "too_expensive",
        reasonLabel: "太贵了",
        comment: index < commentCount ? "出现得太早了" : null,
      });
    }
  }
  await db.insert(events).values(eventRows);
  if (feedbackRows.length > 0) await db.insert(feedback).values(feedbackRows);
}

function assertCodeFacts(snapshot: ReportSnapshot | null) {
  assert.ok(snapshot);
  const { facts, key_changes, caveats, ...rest } = snapshot;
  assert.deepEqual(buildFacts(rest), { facts, key_changes, caveats });
  assert.ok(facts.some((fact) => fact.text.includes("整体转化率") && fact.source_keys.includes("funnel.current.overall")));
}

const small = await createProject("phase4-small");
await seedSessions(small.id, 3, 1, 0);
let blockedCalls = 0;
const blocked: AiProvider = {
  model: "should-not-run",
  async generateStructured() {
    blockedCalls += 1;
    throw new Error("不应该调用");
  },
};
const insufficient = await generateReport(db, small, {
  periodKind: "7d",
  appVersion: null,
  paywallVersion: null,
  now,
  provider: blocked,
});
assert.equal(insufficient.status, "insufficient_data");
assert.equal(insufficient.output, null);
assert.equal(insufficient.model, null);
assert.equal(insufficient.periodStart, "2026-09-15");
assert.equal(insufficient.periodEnd, "2026-09-21");
assert.equal(blockedCalls, 0);
assertCodeFacts(insufficient.inputSnapshot);
assert.equal(insufficient.inputSnapshot?.thresholds.met, false);

const big = await createProject("phase4-big");
await seedSessions(big.id, 100, 20, 5);
let successCalls = 0;
const successProvider: AiProvider = {
  model: "fake-model",
  async generateStructured<T>(input) {
    successCalls += 1;
    if (input.name === "theme_assignments") {
      const body = JSON.parse(input.user) as { comments: Array<{ id: string }> };
      return { assignments: body.comments.map((comment) => ({ comment_id: comment.id, theme: "paywall_too_early" })) } as T;
    }
    const body = JSON.parse(input.user) as ReportSnapshot;
    const overall = body.facts.find((fact) => fact.source_keys.includes("funnel.current.overall"));
    const lowSample = body.facts.find((fact) => fact.source_keys.some((key) => key.startsWith("feedback.reasons[")));
    assert.ok(overall);
    assert.ok(lowSample);
    return {
      hypotheses: [
        { id: "H1", text: "可以延后展示付费页", based_on: [overall.id], confidence: "medium" },
        { id: "H2", text: "也许有 9999 人离开", based_on: [overall.id], confidence: "low" },
        { id: "H3", text: "依据不存在", based_on: ["F99"], confidence: "low" },
        { id: "H4", text: "价格可能是主要顾虑", based_on: [lowSample.id], confidence: "low" },
        { id: "H5", text: "因为价格偏高", based_on: [overall.id], confidence: "low" },
      ],
      suggested_tests: [
        { id: "T1", text: "延后展示付费页", for_hypothesis: "H1", measure: "对比两个版本的点击" },
        { id: "T2", text: "按 9999 来判断", for_hypothesis: "H1", measure: "看是否达到 9999" },
        { id: "T3", text: "跟着被丢掉的假设", for_hypothesis: "H3", measure: "观察转化" },
      ],
      notes: "整体还可以再观察",
    } as T;
  },
};
const done = await generateReport(db, big, {
  periodKind: "7d",
  appVersion: null,
  paywallVersion: null,
  now,
  provider: successProvider,
});
assert.equal(done.status, "done");
assert.equal(done.model, "fake-model");
assert.equal(successCalls, 2);
assert.equal(done.output?.hypotheses.length, 1);
assert.equal(done.output?.hypotheses[0]?.id, "H1");
assert.equal(done.output?.suggested_tests.length, 1);
assert.equal(done.output?.suggested_tests[0]?.for_hypothesis, "H1");
assert.equal(done.output?.notes, "整体还可以再观察");
assert.ok(done.inputSnapshot?.facts.some((fact) => fact.text === "5 条文字反馈归为主题「付费页出现得太早」"));
assert.ok(Array.isArray(done.inputSnapshot?.by_product));
assertCodeFacts(done.inputSnapshot);
const again = await generateReport(db, big, {
  periodKind: "7d",
  appVersion: null,
  paywallVersion: null,
  now,
  provider: successProvider,
});
assert.equal(again.id, done.id);
assert.equal(successCalls, 2);

const rejected = await generateReport(db, big, {
  periodKind: "30d",
  appVersion: null,
  paywallVersion: null,
  now,
  provider: {
    model: "fake-model",
    async generateStructured<T>(input) {
      if (input.name === "theme_assignments") {
        const body = JSON.parse(input.user) as { comments: Array<{ id: string }> };
        return { assignments: body.comments.map((comment) => ({ comment_id: comment.id, theme: "paywall_too_early" })) } as T;
      }
      return {
        hypotheses: [{ id: "Hbad", text: "也许有 9999 人", based_on: ["F99"], confidence: "low" }],
        suggested_tests: [{ id: "Tbad", text: "无效", for_hypothesis: "Hbad", measure: "观察" }],
        notes: "",
      } as T;
    },
  },
});
assert.equal(rejected.status, "failed");
assert.equal(rejected.output, null);
assert.match(rejected.error ?? "", /校验/);
assertCodeFacts(rejected.inputSnapshot);

const missing = await generateReport(db, big, {
  periodKind: "30d",
  appVersion: null,
  paywallVersion: null,
  now,
  provider: null,
});
assert.equal(missing.status, "failed");
assert.equal(missing.output, null);
assert.match(missing.error ?? "", /配置|openai/);
assert.notEqual(missing.id, rejected.id);

console.log("phase 4 ok");
