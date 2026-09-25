export type RateStatus = "hidden" | "insufficient" | "small_sample" | "ok";

export type RateView = {
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  interval: { low: number; high: number } | null;
  status: RateStatus;
};

export type Signal = "hidden" | "insufficient" | "no_difference" | "weak" | "clear" | "incomparable";

/** Wilson 95% 区间。total 为 0 时返回 0 到 0，调用方不应把它当成真实区间。 */
export function wilson95(successes: number, total: number, z = 1.96) {
  if (total <= 0) return { low: 0, high: 0 };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function presentRate(numerator: number, denominator: number): RateView {
  if (denominator < 5) {
    return { numerator: null, denominator: null, rate: null, interval: null, status: "hidden" };
  }
  if (denominator < 30) {
    return { numerator, denominator, rate: null, interval: null, status: "insufficient" };
  }
  const rate = numerator / denominator;
  const interval = wilson95(numerator, denominator);
  if (denominator < 100) {
    return { numerator, denominator, rate, interval, status: "small_sample" };
  }
  return { numerator, denominator, rate, interval, status: "ok" };
}

export function intervalsOverlap(
  left: { low: number; high: number },
  right: { low: number; high: number },
) {
  return left.low <= right.high && right.low <= left.high;
}

export function compareSignal(currentDenom: number, priorDenom: number, currentNumerator: number, priorNumerator: number): Signal {
  if (currentDenom < 5 || priorDenom < 5) return "hidden";
  if (currentDenom < 30 || priorDenom < 30) return "insufficient";
  const current = wilson95(currentNumerator, currentDenom);
  const prior = wilson95(priorNumerator, priorDenom);
  if (intervalsOverlap(current, prior)) return "no_difference";
  if (currentDenom < 100 || priorDenom < 100) return "weak";
  return "clear";
}

export const SIGNAL_LABEL: Record<Signal, string> = {
  hidden: "样本不足",
  insufficient: "样本不足",
  no_difference: "看不出差别",
  weak: "弱信号",
  clear: "清楚",
  incomparable: "不可比",
};
