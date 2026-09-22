import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import type { AiProvider, JsonSchema } from "@/lib/ai-provider";
import { aiReports } from "@/db/schema";
import { completeReportPeriod, type Period } from "@/lib/period";
import {
  buildFacts,
  PRESET_THEMES,
  validateInference,
  type Inference,
  type ReportSnapshot,
} from "@/lib/report-facts";
import { buildMeasuredSnapshot, type ThemeComment } from "@/lib/snapshot";

export const PROMPT_VERSION = "paylens-report-v1";
const RECENT_REPORT_MS = 60 * 60 * 1000;
const NEW_THEME_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

const themeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assignments"],
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["comment_id", "theme"],
        properties: {
          comment_id: { type: "string" },
          theme: { type: "string" },
        },
      },
    },
  },
};

const inferenceSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hypotheses", "suggested_tests", "notes"],
  properties: {
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "based_on", "confidence"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          based_on: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    suggested_tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "for_hypothesis", "measure"],
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          for_hypothesis: { type: "string" },
          measure: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
  },
};

export type StoredReport = {
  id: string;
  status: "pending" | "done" | "failed" | "insufficient_data";
  timezone: string;
  periodStart: string;
  periodEnd: string;
  compareStart: string;
  compareEnd: string;
  filters: { app_version: string | null; paywall_version: string | null };
  model: string | null;
  promptVersion: string | null;
  inputSnapshot: ReportSnapshot | null;
  output: Inference | null;
  error: string | null;
  createdAt: Date;
};

function dateKey(value: unknown) {
  if (value instanceof Date) {
    const utcMidnight =
      value.getUTCHours() === 0 &&
      value.getUTCMinutes() === 0 &&
      value.getUTCSeconds() === 0 &&
      value.getUTCMilliseconds() === 0;
    if (utcMidnight) return value.toISOString().slice(0, 10);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value ?? "").slice(0, 10);
}

function asFilters(value: unknown): StoredReport["filters"] {
  const record = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!record || typeof record !== "object") return { app_version: null, paywall_version: null };
  const filters = record as { app_version?: unknown; paywall_version?: unknown };
  return {
    app_version: typeof filters.app_version === "string" ? filters.app_version : null,
    paywall_version: typeof filters.paywall_version === "string" ? filters.paywall_version : null,
  };
}

function asSnapshot(value: unknown): ReportSnapshot | null {
  if (!value || typeof value !== "object") return null;
  return value as ReportSnapshot;
}

function asInference(value: unknown): Inference | null {
  if (!value || typeof value !== "object") return null;
  return value as Inference;
}

function toStored(row: typeof aiReports.$inferSelect): StoredReport {
  return {
    id: row.id,
    status: row.status as StoredReport["status"],
    timezone: row.timezone,
    periodStart: dateKey(row.periodStart),
    periodEnd: dateKey(row.periodEnd),
    compareStart: dateKey(row.compareStart),
    compareEnd: dateKey(row.compareEnd),
    filters: asFilters(row.filters),
    model: row.model,
    promptVersion: row.promptVersion,
    inputSnapshot: asSnapshot(row.inputSnapshot),
    output: asInference(row.output),
    error: row.error,
    createdAt: row.createdAt,
  };
}

function sameFilters(actual: StoredReport["filters"], expected: StoredReport["filters"]) {
  return actual.app_version === expected.app_version && actual.paywall_version === expected.paywall_version;
}

function groupThemes(comments: ThemeComment[], assignments: Map<string, string>) {
  const buckets = new Map<string, string[]>();
  for (const comment of comments) {
    const raw = assignments.get(comment.id) ?? "other";
    const theme = PRESET_THEMES.includes(raw) || NEW_THEME_PATTERN.test(raw) ? raw : "other";
    const examples = buckets.get(theme) ?? [];
    examples.push(comment.text);
    buckets.set(theme, examples);
  }
  const themes: ReportSnapshot["comment_themes"] = [];
  const other = [...(buckets.get("other") ?? [])];
  for (const [theme, examples] of buckets) {
    if (theme === "other") continue;
    if (!PRESET_THEMES.includes(theme) && examples.length < 2) {
      other.push(...examples);
      continue;
    }
    themes.push({
      theme,
      count: examples.length,
      examples: examples.slice(0, 2).map((text) => Array.from(text).slice(0, 80).join("")),
    });
  }
  if (other.length > 0) {
    themes.push({
      theme: "other",
      count: other.length,
      examples: other.slice(0, 2).map((text) => Array.from(text).slice(0, 80).join("")),
    });
  }
  return themes.sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
}

function readAssignments(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { assignments?: unknown }).assignments)) {
    throw new Error("主题归类格式不正确");
  }
  const assignments = new Map<string, string>();
  for (const item of (value as { assignments: unknown[] }).assignments) {
    if (!item || typeof item !== "object") continue;
    const row = item as { comment_id?: unknown; theme?: unknown };
    if (typeof row.comment_id === "string" && typeof row.theme === "string") {
      assignments.set(row.comment_id, row.theme);
    }
  }
  return assignments;
}

async function insertReport(
  db: Database,
  projectId: string,
  snapshot: ReportSnapshot,
  values: { status: StoredReport["status"]; model: string | null; output: Inference | null; error: string | null },
) {
  const [row] = await db
    .insert(aiReports)
    .values({
      projectId,
      timezone: snapshot.timezone,
      periodStart: snapshot.period.start,
      periodEnd: snapshot.period.end,
      compareStart: snapshot.compare.start,
      compareEnd: snapshot.compare.end,
      filters: snapshot.filters,
      status: values.status,
      model: values.model,
      promptVersion: PROMPT_VERSION,
      inputSnapshot: snapshot,
      output: values.output,
      error: values.error,
    })
    .returning();
  return toStored(row!);
}

export async function generateReport(
  db: Database,
  project: { id: string; timezone: string },
  input: {
    periodKind: "7d" | "30d";
    appVersion: string | null;
    paywallVersion: string | null;
    now: Date;
    provider: AiProvider | null;
  },
) {
  const period = completeReportPeriod(project.timezone, input.periodKind, input.now);
  const filters = { app_version: input.appVersion, paywall_version: input.paywallVersion };
  const cutoff = new Date(Date.now() - RECENT_REPORT_MS);
  const recent = await db
    .select()
    .from(aiReports)
    .where(
      and(
        eq(aiReports.projectId, project.id),
        eq(aiReports.periodStart, period.from),
        eq(aiReports.periodEnd, period.to),
        inArray(aiReports.status, ["done", "insufficient_data"]),
        gte(aiReports.createdAt, cutoff),
      ),
    )
    .orderBy(desc(aiReports.createdAt));
  const existing = recent.map(toStored).find((report) => sameFilters(report.filters, filters));
  if (existing) return existing;

  const measured = await buildMeasuredSnapshot(db, project, {
    period,
    now: input.now,
    appVersion: input.appVersion,
    paywallVersion: input.paywallVersion,
  });
  const { comments, ...base } = measured;
  if (!base.thresholds.met) {
    const facts = buildFacts({ ...base, comment_themes: [] });
    return insertReport(db, project.id, { ...base, comment_themes: [], ...facts }, {
      status: "insufficient_data",
      model: null,
      output: null,
      error: null,
    });
  }

  try {
    if (!input.provider) {
      const named = process.env.AI_PROVIDER?.trim();
      const facts = buildFacts({ ...base, comment_themes: [] });
      return insertReport(db, project.id, { ...base, comment_themes: [], ...facts }, {
        status: "failed",
        model: null,
        output: null,
        error:
          named && named !== "openai"
            ? "V0.1 只支持 AI_PROVIDER=openai。"
            : "还没有配置 AI。请在服务端设置 AI_PROVIDER、AI_API_KEY 和 AI_MODEL。",
      });
    }
    const assignments =
      comments.length === 0
        ? new Map<string, string>()
        : readAssignments(
            await input.provider.generateStructured({
              name: "theme_assignments",
              schema: themeSchema,
              system:
                "你只把评论归入主题。预置主题：paywall_too_early、core_feature_not_experienced、price_too_high_annual、price_too_high_monthly、want_trial、unclear_value、payment_error、already_has_alternative、other。无法归入时可以输出新的 snake_case 主题。不要写解释。",
              user: JSON.stringify({ comments }),
            }),
          );
    const commentThemes = groupThemes(comments, assignments);
    const facts = buildFacts({ ...base, comment_themes: commentThemes });
    const snapshot: ReportSnapshot = { ...base, comment_themes: commentThemes, ...facts };
    const raw = await input.provider.generateStructured({
      name: "report_inference",
      schema: inferenceSchema,
      system:
        "你只能根据 facts 写假设和建议测试。不得发明数字，文本中的数字必须已经出现在输入里。不得使用“导致”“因为”“证明”。不要引用 low_sample 的原因。confidence 只能是 low、medium、high。based_on 只能填写存在的 fact id。notes 不要写数字。",
      user: JSON.stringify(snapshot),
    });
    const validated = validateInference(raw, snapshot);
    if (!validated.ok) {
      return insertReport(db, project.id, snapshot, {
        status: "failed",
        model: input.provider.model,
        output: null,
        error: "推断里的依据或数字没有通过校验，已全部丢弃。",
      });
    }
    return insertReport(db, project.id, snapshot, {
      status: "done",
      model: input.provider.model,
      output: validated.inference,
      error: null,
    });
  } catch (error) {
    const facts = buildFacts({ ...base, comment_themes: [] });
    const message = error instanceof Error ? error.message : "AI 报告生成失败";
    return insertReport(db, project.id, { ...base, comment_themes: [], ...facts }, {
      status: "failed",
      model: input.provider?.model ?? null,
      output: null,
      error: message.slice(0, 300),
    });
  }
}

export async function listReports(db: Database, projectId: string) {
  const rows = await db
    .select()
    .from(aiReports)
    .where(eq(aiReports.projectId, projectId))
    .orderBy(desc(aiReports.createdAt))
    .limit(20);
  return rows.map(toStored);
}

export async function getReport(db: Database, projectId: string, reportId: string) {
  const [row] = await db
    .select()
    .from(aiReports)
    .where(and(eq(aiReports.projectId, projectId), eq(aiReports.id, reportId)))
    .limit(1);
  return row ? toStored(row) : null;
}

export function readReportRequest(input: {
  period: unknown;
  appVersion: unknown;
  paywallVersion: unknown;
}):
  | { ok: true; periodKind: "7d" | "30d"; appVersion: string | null; paywallVersion: string | null }
  | { ok: false; message: string } {
  if (input.period !== "7d" && input.period !== "30d") {
    return { ok: false, message: "周期只能是近 7 天或近 30 天。" };
  }
  const appVersion = readOptionalText(input.appVersion, 32, "App 版本");
  if (!appVersion.ok) return appVersion;
  const paywallVersion = readOptionalText(input.paywallVersion, 64, "Paywall 版本");
  if (!paywallVersion.ok) return paywallVersion;
  return {
    ok: true,
    periodKind: input.period,
    appVersion: appVersion.value,
    paywallVersion: paywallVersion.value,
  };
}

function readOptionalText(value: unknown, max: number, label: string) {
  if (value == null) return { ok: true as const, value: null };
  if (typeof value !== "string") return { ok: false as const, message: `${label}格式不正确。` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, value: null };
  if (trimmed.length > max) return { ok: false as const, message: `${label}最长 ${max} 个字符。` };
  return { ok: true as const, value: trimmed };
}

export type { Period };
