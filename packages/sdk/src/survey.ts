export const REASON_CODE_PATTERN = /^[a-z_]{2,40}$/;
export const MAX_COMMENT_CHARS = 300;

export type SurveyOption = { code: string; label: string };

export type SurveyConfig = {
  question: string;
  options: SurveyOption[];
  allowComment: boolean;
  cooldownDays: number;
};

export const DEFAULT_SURVEY: SurveyConfig = {
  question: "这次没有升级 Pro 的主要原因是什么？",
  options: [
    { code: "too_expensive", label: "价格有点高" },
    { code: "need_more_time", label: "还想再体验一下" },
    { code: "free_is_enough", label: "免费版已经够用了" },
    { code: "unclear_value", label: "没看懂 Pro 的价值" },
    { code: "no_need_now", label: "暂时没有需要" },
    { code: "payment_issue", label: "支付遇到了问题" },
    { code: "other", label: "其他" },
  ],
  allowComment: true,
  cooldownDays: 7,
};

export function shouldAskComment(code: string | null, allowComment: boolean) {
  return Boolean(allowComment && code === "other");
}

export function clampComment(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, MAX_COMMENT_CHARS).join("");
}

export function normalizeSurvey(input?: {
  question?: string;
  options?: SurveyOption[];
  allowComment?: boolean;
  cooldownDays?: number;
}): SurveyConfig {
  const custom = (input?.options ?? []).filter(
    (option) => REASON_CODE_PATTERN.test(option.code) && option.label.trim().length > 0,
  );
  if (input?.options && custom.length !== input.options.length) {
    console.warn("[PayLens] 有调查选项的 code 不合法，已忽略。code 只能是 2–40 位小写字母和下划线。");
  }
  const cooldown = input?.cooldownDays;
  return {
    question: input?.question?.trim() || DEFAULT_SURVEY.question,
    options: custom.length > 0 ? custom.map((option) => ({ code: option.code, label: option.label.trim() })) : DEFAULT_SURVEY.options,
    allowComment: input?.allowComment ?? DEFAULT_SURVEY.allowComment,
    cooldownDays: typeof cooldown === "number" && cooldown >= 0 ? cooldown : DEFAULT_SURVEY.cooldownDays,
  };
}
