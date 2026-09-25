const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 366;

export type Period = { from: string; to: string };

export type DashboardQuery = {
  period: Period;
  appVersion: string | null;
  paywallVersion: string | null;
  platform: "ios" | "android" | null;
};

type QueryParams = {
  range?: string | null;
  from?: string | null;
  to?: string | null;
  app_version?: string | null;
  paywall_version?: string | null;
  platform?: string | null;
};

export function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  const nextYear = utc.getUTCFullYear();
  const nextMonth = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(utc.getUTCDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function completeReportPeriod(timezone: string, kind: "7d" | "30d", now: Date): Period {
  const yesterday = addDays(formatLocalDate(now, timezone), -1);
  const days = kind === "30d" ? 30 : 7;
  return { from: addDays(yesterday, -(days - 1)), to: yesterday };
}

export function previousPeriod(period: Period): Period {
  const start = Date.parse(`${period.from}T00:00:00Z`);
  const end = Date.parse(`${period.to}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000) + 1;
  const to = addDays(period.from, -1);
  return { from: addDays(to, -(days - 1)), to };
}

export function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to && dates.length <= MAX_RANGE_DAYS) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

export function resolvePeriod(input: {
  timezone: string;
  now?: Date;
  range?: string | null;
  from?: string | null;
  to?: string | null;
}): { ok: true; period: Period } | { ok: false; message: string } {
  const now = input.now ?? new Date();
  const today = formatLocalDate(now, input.timezone);
  const range = input.range?.trim() ?? "";
  const from = input.from?.trim() ?? "";
  const to = input.to?.trim() ?? "";

  if (range === "7d" || range === "30d" || (range === "" && !from && !to)) {
    const days = range === "30d" ? 30 : 7;
    return { ok: true, period: { from: addDays(today, -(days - 1)), to: today } };
  }

  if (range !== "" && range !== "custom") {
    return { ok: false, message: "日期范围只能是最近 7 天、最近 30 天，或自定义起止日期。" };
  }

  if (!from || !to) {
    return { ok: false, message: "自定义范围需要同时填写开始和结束日期。" };
  }
  if (!isRealDate(from) || !isRealDate(to)) {
    return { ok: false, message: "日期格式应为 YYYY-MM-DD，并且是真实存在的日期。" };
  }
  if (from > to) {
    return { ok: false, message: "开始日期不能晚于结束日期。" };
  }
  if (inclusiveDays(from, to) > MAX_RANGE_DAYS) {
    return { ok: false, message: "一次最多查看 366 天。" };
  }
  return { ok: true, period: { from, to } };
}

function readVersion(value: string | null | undefined, max: number, label: string) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return { ok: true as const, value: null };
  if (trimmed.length > max) return { ok: false as const, message: `${label}筛选最长 ${max} 个字符。` };
  return { ok: true as const, value: trimmed };
}

export function parseDashboardQuery(
  timezone: string,
  params: QueryParams,
  now = new Date(),
): { ok: true; query: DashboardQuery } | { ok: false; message: string } {
  const period = resolvePeriod({
    timezone,
    now,
    range: params.range,
    from: params.from,
    to: params.to,
  });
  if (!period.ok) return period;

  const appVersion = readVersion(params.app_version, 32, "App 版本");
  if (!appVersion.ok) return appVersion;
  const paywallVersion = readVersion(params.paywall_version, 64, "Paywall 版本");
  if (!paywallVersion.ok) return paywallVersion;
  const platform = (params.platform ?? "").trim();
  if (platform !== "" && platform !== "ios" && platform !== "android") {
    return { ok: false, message: "平台只能是 iOS 或 Android。" };
  }

  return {
    ok: true,
    query: {
      period: period.period,
      appVersion: appVersion.value,
      paywallVersion: paywallVersion.value,
      platform: platform === "" ? null : platform,
    },
  };
}
