export const EVENT_NAMES = [
  "paywall_viewed",
  "subscribe_clicked",
  "purchase_success",
  "paywall_closed",
  "purchase_failed",
] as const;

export const FAILURE_KINDS = ["user_cancelled", "payment_error", "unknown"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export type EventName = (typeof EVENT_NAMES)[number];

export const PURCHASE_WINDOW_MS = 10 * 60 * 1000;

export type SessionState = {
  id: string;
  paywallVersion: string | null;
  closedAt: number | null;
  purchased: boolean;
  /** 只有 paywall_viewed 开启的 session 才能出现退出调查。 */
  viewed: boolean;
} | null;

export type TrackDecision = {
  state: SessionState;
  sessionId: string | null;
  paywallVersion: string | null;
  warn: string | null;
};

function isLive(state: SessionState) {
  return Boolean(state && !state.purchased && state.closedAt == null);
}

function inPurchaseWindow(state: SessionState, now: number) {
  return Boolean(state && !state.purchased && state.closedAt != null && now - state.closedAt <= PURCHASE_WINDOW_MS);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 调查只在「看到并关闭、且没有购买」的这次 Paywall 上出现，并遵守本地冷却期。 */
export function canShowExitSurvey(
  state: SessionState,
  lastShownAt: number | null,
  now: number,
  cooldownDays: number,
) {
  if (!state?.viewed || state.purchased || state.closedAt == null) return false;
  if (lastShownAt == null) return true;
  return now - lastShownAt >= cooldownDays * DAY_MS;
}

export function applyTrack(input: {
  state: SessionState;
  eventName: EventName;
  now: number;
  createId: () => string;
  defaultPaywallVersion: string | null;
  paywallVersion?: string;
}): TrackDecision {
  const { state, eventName, now, createId, defaultPaywallVersion } = input;
  if (eventName === "paywall_viewed") {
    if (isLive(state)) {
      return {
        state,
        sessionId: null,
        paywallVersion: state?.paywallVersion ?? null,
        warn: "session 尚未结束，忽略重复的 paywall_viewed",
      };
    }
    const paywallVersion = input.paywallVersion ?? defaultPaywallVersion;
    const next = { id: createId(), paywallVersion, closedAt: null, purchased: false, viewed: true };
    return { state: next, sessionId: next.id, paywallVersion, warn: null };
  }

  if (eventName === "purchase_success") {
    if (isLive(state) || inPurchaseWindow(state, now)) {
      const current = state as NonNullable<SessionState>;
      return {
        state: { ...current, purchased: true },
        sessionId: current.id,
        paywallVersion: current.paywallVersion,
        warn: null,
      };
    }
    const next = {
      id: createId(),
      paywallVersion: defaultPaywallVersion,
      closedAt: null,
      purchased: true,
      viewed: false,
    };
    return {
      state: next,
      sessionId: next.id,
      paywallVersion: next.paywallVersion,
      warn: "没有打开的 Paywall session，已单独记录 purchase_success",
    };
  }

  if (eventName === "purchase_failed") {
    if (isLive(state)) {
      const current = state as NonNullable<SessionState>;
      return { state: current, sessionId: current.id, paywallVersion: current.paywallVersion, warn: null };
    }
    const next = {
      id: createId(),
      paywallVersion: defaultPaywallVersion,
      closedAt: null,
      purchased: false,
      viewed: false,
    };
    return {
      state: next,
      sessionId: next.id,
      paywallVersion: next.paywallVersion,
      warn: "没有打开的 Paywall session，已单独记录 purchase_failed",
    };
  }

  if (eventName === "paywall_closed") {
    if (isLive(state)) {
      const current = state as NonNullable<SessionState>;
      return {
        state: { ...current, closedAt: now },
        sessionId: current.id,
        paywallVersion: current.paywallVersion,
        warn: null,
      };
    }
    const next = {
      id: createId(),
      paywallVersion: defaultPaywallVersion,
      closedAt: now,
      purchased: false,
      viewed: false,
    };
    return {
      state: next,
      sessionId: next.id,
      paywallVersion: next.paywallVersion,
      warn: "没有打开的 Paywall session，已单独记录 paywall_closed",
    };
  }

  if (isLive(state)) {
    const current = state as NonNullable<SessionState>;
    return { state: current, sessionId: current.id, paywallVersion: current.paywallVersion, warn: null };
  }
  const next = {
    id: createId(),
    paywallVersion: defaultPaywallVersion,
    closedAt: null,
    purchased: false,
    viewed: false,
  };
  return {
    state: next,
    sessionId: next.id,
    paywallVersion: next.paywallVersion,
    warn: "没有打开的 Paywall session，已单独记录 subscribe_clicked",
  };
}
