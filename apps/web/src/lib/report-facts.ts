import { DROP_LABELS, type DropStep } from "@/lib/funnel";
import {
  MIN_PRODUCT_CLICKS,
  MIN_THEME_COUNT,
  REASON_CHANGE_PP,
} from "@/lib/thresholds";

export const THEME_LABELS: Record<string, string> = {
  paywall_too_early: "付费页出现得太早",
  core_feature_not_experienced: "还没体验核心功能",
  price_too_high_annual: "年付价格偏高",
  price_too_high_monthly: "月付价格偏高",
  want_trial: "想先试用",
  unclear_value: "没看懂价值",
  payment_error: "支付出错",
  already_has_alternative: "已经有替代方案",
  other: "其他",
};

export const PRESET_THEMES = Object.keys(THEME_LABELS);

export type SnapshotEvidence = {
  evidence_id: string;
  tool: string;
  args: {
    period: { from: string; to: string };
    compare?: { from: string; to: string };
    platform: "ios" | "android" | null;
    app_version: string | null;
    paywall_version: string | null;
    as_of: string | null;
  };
};

export type SnapshotFact = {
  id: string;
  evidence_id: string;
  class: "measured" | "direct" | "behavioral";
  text: string;
  source_keys: string[];
};

export type ReportSnapshot = {
  timezone: string;
  period: { start: string; end: string; days: number };
  compare: { start: string; end: string };
  filters: { app_version: string | null; paywall_version: string | null; platform?: "ios" | "android" | null };
  thresholds: { min_sessions: number; min_feedback: number; min_reason_count: number; met: boolean };
  funnel: {
    current: FunnelCounts;
    previous: FunnelCounts;
    biggest_drop: { step: DropStep; lost: number; lost_rate: number | null } | null;
  };
  feedback: {
    total: number;
    closed_without_purchase: number;
    response_rate: number | null;
    reasons: Array<{
      code: string;
      label: string;
      count: number;
      share: number;
      prev_count: number;
      prev_share: number | null;
      delta_pp: number | null;
      low_sample: boolean;
    }>;
  };
  comment_themes: Array<{ theme: string; count: number; examples: string[] }>;
  by_product: Array<{ product_id: string; clicked: number; purchased: number }>;
  evidence?: SnapshotEvidence[];
  facts: SnapshotFact[];
  key_changes: string[];
  caveats: string[];
};

type FunnelCounts = {
  sessions: number;
  clicked: number;
  purchased: number;
  payment_error: number;
  view_to_click: number | null;
  click_to_purchase: number | null;
  overall: number | null;
};

export type Inference = {
  hypotheses: Array<{ id: string; text: string; based_on: string[]; confidence: "low" | "medium" | "high" }>;
  suggested_tests: Array<{ id: string; text: string; for_hypothesis: string; measure: string }>;
  notes: string | null;
};

const CAUSAL_WORDS = ["导致", "因为", "证明"];
const NUMBER_PATTERN = /(?<![A-Za-z])\d+(?:\.\d+)?/g;

function percent(rate: number | null) {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function roundedPp(current: number | null, previous: number | null) {
  if (current === null || previous === null) return null;
  return Number(((current - previous) * 100).toFixed(1));
}

function changePhrase(delta: number | null) {
  if (delta === null) return "上期没有足够的展示可比";
  if (delta === 0) return "与上期相同";
  const direction = delta > 0 ? "上升" : "下降";
  return `${direction} ${Math.abs(delta)} 个百分点`;
}

function themeLabel(theme: string) {
  return THEME_LABELS[theme] ?? theme;
}

/** 事实句全部由模板生成。模型看不到写这些句子的机会。 */
export function buildFacts(snapshot: Omit<ReportSnapshot, "facts" | "key_changes" | "caveats">) {
  const facts: SnapshotFact[] = [];
  const keyChanges: string[] = [];
  const evidenceIdFor = (tool: string) =>
    snapshot.evidence?.find((item) => item.tool === tool)?.evidence_id ?? "ev_unscoped";
  const add = (
    text: string,
    sourceKeys: string[],
    factClass: SnapshotFact["class"] = "measured",
    keyChange = false,
    tool = "get_paywall_funnel",
  ) => {
    const id = `F${facts.length + 1}`;
    facts.push({ id, evidence_id: evidenceIdFor(tool), class: factClass, text, source_keys: sourceKeys });
    if (keyChange) keyChanges.push(id);
  };

  const overallDelta = roundedPp(snapshot.funnel.current.overall, snapshot.funnel.previous.overall);
  add(
    `整体转化率 ${percent(snapshot.funnel.current.overall)}，上期 ${percent(snapshot.funnel.previous.overall)}，${changePhrase(overallDelta)}`,
    ["funnel.current.overall", "funnel.previous.overall"],
    "measured",
    overallDelta !== null && overallDelta !== 0,
  );

  if (snapshot.funnel.biggest_drop) {
    const drop = snapshot.funnel.biggest_drop;
    const rate = drop.lost_rate === null ? "" : `（${percent(drop.lost_rate)}）`;
    add(`最大流失点：${DROP_LABELS[drop.step]}，流失 ${drop.lost} 次${rate}`, ["funnel.biggest_drop"]);
  } else {
    add("这个周期没有可以比较的流失点", ["funnel.biggest_drop"]);
  }

  const steps = [
    ["view_to_click", "看到付费页后点击"],
    ["click_to_purchase", "点击订阅后购买"],
  ] as const;
  for (const [key, label] of steps) {
    const delta = roundedPp(snapshot.funnel.current[key], snapshot.funnel.previous[key]);
    add(
      `${label} ${percent(snapshot.funnel.current[key])}，上期 ${percent(snapshot.funnel.previous[key])}，${changePhrase(delta)}`,
      [`funnel.current.${key}`, `funnel.previous.${key}`],
      "measured",
      delta !== null && delta !== 0,
    );
  }

  const top = snapshot.feedback.reasons[0];
  if (top) {
    add(`“${top.label}”占 ${percent(top.share)}（n=${top.count}）`, [`feedback.reasons[${top.code}]`], "direct", false, "get_feedback_reasons");
  } else {
    add("这个周期没有反馈", ["feedback.total"]);
  }

  const changes = snapshot.feedback.reasons
    .filter((reason) => !reason.low_sample && reason.delta_pp !== null && Math.abs(reason.delta_pp) >= REASON_CHANGE_PP)
    .sort((a, b) => Math.abs(b.delta_pp ?? 0) - Math.abs(a.delta_pp ?? 0) || a.code.localeCompare(b.code));
  for (const reason of changes) {
    const direction = (reason.delta_pp ?? 0) > 0 ? "上升" : "下降";
    add(
      `“${reason.label}”占 ${percent(reason.share)}（n=${reason.count}），上期 ${percent(reason.prev_share)}，${direction} ${Math.abs(reason.delta_pp ?? 0)} 个百分点`,
      [`feedback.reasons[${reason.code}]`],
      "direct",
      true,
      "get_feedback_reasons",
    );
  }

  for (const theme of [...snapshot.comment_themes].sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme))) {
    if (theme.count < MIN_THEME_COUNT) continue;
    add(
      `${theme.count} 条文字反馈归为主题「${themeLabel(theme.theme)}」`,
      [`comment_themes[${theme.theme}]`],
      "direct",
      false,
      "get_feedback_themes",
    );
  }

  const products = snapshot.by_product.filter((product) => product.clicked >= MIN_PRODUCT_CLICKS);
  if (products.length >= 2) {
    const text = products
      .map((product) => `${product.product_id} 点击 ${product.clicked} 次、购买 ${product.purchased} 次`)
      .join("；");
    add(`分产品：${text}`, ["by_product"], "measured", false, "product_counts");
  }

  const response =
    snapshot.feedback.response_rate === null
      ? "没有关闭未购买的展示，无法计算回答率"
      : `回答率 ${percent(snapshot.feedback.response_rate)}，回答者可能不代表全部未购买用户`;
  return {
    facts,
    key_changes: keyChanges,
    caveats: [response, "漏斗按 Paywall 展示次数计算，同一用户多次打开会被计多次"],
  };
}

function collectNumbers(value: unknown, into: number[]) {
  if (typeof value === "number" && Number.isFinite(value)) {
    into.push(value);
    return;
  }
  if (typeof value === "string") {
    for (const match of value.matchAll(NUMBER_PATTERN)) into.push(Number(match[0]));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, into);
  }
}

function numbersInText(text: string) {
  return [...text.matchAll(NUMBER_PATTERN)].map((match) => Number(match[0]));
}

function numberAllowed(value: number, allowed: number[]) {
  return allowed.some((candidate) => Math.abs(candidate - value) <= 0.1);
}

function citesLowSample(fact: SnapshotFact, snapshot: ReportSnapshot) {
  return fact.source_keys.some((key) => {
    const match = /^feedback\.reasons\[(.+)\]$/.exec(key);
    if (!match) return false;
    return snapshot.feedback.reasons.some((reason) => reason.code === match[1] && reason.low_sample);
  });
}

function hasCausalWords(text: string) {
  return CAUSAL_WORDS.some((word) => text.includes(word));
}

function textAllowed(text: string, allowed: number[]) {
  if (!text.trim() || hasCausalWords(text)) return false;
  return numbersInText(text).every((value) => numberAllowed(value, allowed));
}

export function validateInference(raw: unknown, snapshot: ReportSnapshot): { ok: true; inference: Inference; dropped: number } | { ok: false } {
  if (!raw || typeof raw !== "object") return { ok: false };
  const record = raw as { hypotheses?: unknown; suggested_tests?: unknown; notes?: unknown };
  if (!Array.isArray(record.hypotheses) || !Array.isArray(record.suggested_tests)) return { ok: false };
  const allowed = [] as number[];
  collectNumbers(snapshot, allowed);
  const factsById = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
  let dropped = 0;
  const hypotheses: Inference["hypotheses"] = [];
  for (const item of record.hypotheses) {
    if (!item || typeof item !== "object") {
      dropped += 1;
      continue;
    }
    const hypothesis = item as { id?: unknown; text?: unknown; based_on?: unknown; confidence?: unknown };
    const basedOn = Array.isArray(hypothesis.based_on) ? hypothesis.based_on.filter((id) => typeof id === "string") : [];
    const confidence = hypothesis.confidence;
    const text = typeof hypothesis.text === "string" ? hypothesis.text.trim() : "";
    const citesKnownFacts =
      basedOn.length > 0 &&
      basedOn.every((id) => {
        const fact = factsById.get(id);
        return Boolean(fact && !citesLowSample(fact, snapshot));
      });
    if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
      dropped += 1;
      continue;
    }
    if (!citesKnownFacts || !textAllowed(text, allowed) || typeof hypothesis.id !== "string") {
      dropped += 1;
      continue;
    }
    hypotheses.push({ id: hypothesis.id, text, based_on: basedOn, confidence });
  }

  const hypothesisIds = new Set(hypotheses.map((item) => item.id));
  const suggestedTests = [];
  for (const item of record.suggested_tests) {
    if (!item || typeof item !== "object") {
      dropped += 1;
      continue;
    }
    const test = item as { id?: unknown; text?: unknown; for_hypothesis?: unknown; measure?: unknown };
    const text = typeof test.text === "string" ? test.text.trim() : "";
    const measure = typeof test.measure === "string" ? test.measure.trim() : "";
    if (
      typeof test.id !== "string" ||
      typeof test.for_hypothesis !== "string" ||
      !hypothesisIds.has(test.for_hypothesis) ||
      !textAllowed(text, allowed) ||
      !textAllowed(measure, allowed)
    ) {
      dropped += 1;
      continue;
    }
    suggestedTests.push({ id: test.id, text, for_hypothesis: test.for_hypothesis, measure });
  }

  let notes: string | null = null;
  if (typeof record.notes === "string" && record.notes.trim()) {
    const text = record.notes.trim();
    if (!hasCausalWords(text) && numbersInText(text).length === 0) notes = text;
  }
  const returned = record.hypotheses.length + record.suggested_tests.length;
  if (returned > 0 && hypotheses.length === 0 && suggestedTests.length === 0) return { ok: false };
  return { ok: true, inference: { hypotheses, suggested_tests: suggestedTests, notes }, dropped };
}
