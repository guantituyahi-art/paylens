import { applyTrack, type EventName, type SessionState } from "./session";
import { createEventId, readExpoApplicationVersion, resolveAppVersion } from "./version";

export const DEFAULT_ENDPOINT = "http://localhost:3000/v1";
const MAX_QUEUE = 500;
const BATCH_SIZE = 50;
const FLUSH_EVERY_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const STORAGE_KEY = "@paylens/state";

export type { EventName };

export type PayLensOptions = {
  clientKey: string;
  appVersion?: string;
  paywallVersion?: string;
  endpoint?: string;
};

export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

type QueuedEvent = {
  event_id: string;
  event_name: EventName;
  anonymous_user_id: string;
  paywall_session_id: string;
  platform: string;
  app_version: string;
  paywall_version?: string;
  product_id?: string;
  occurred_at: string;
};

type PersistedState = {
  anonymousUserId: string;
  queue: QueuedEvent[];
  session: SessionState;
  pausedKey: string | null;
};

export type PayLensDeps = {
  storage?: KeyValueStorage;
  fetch?: typeof fetch;
  now?: () => Date;
  createId?: () => string;
  readAppVersion?: () => string | null;
  platform?: string;
  autoFlush?: boolean;
  initialBackoffMs?: number;
};

function loadAsyncStorage(): KeyValueStorage {
  try {
    const mod = require("@react-native-async-storage/async-storage") as { default?: KeyValueStorage } & KeyValueStorage;
    const storage = mod.default ?? mod;
    if (typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      throw new Error("missing methods");
    }
    return storage;
  } catch {
    throw new Error(
      "请安装 @react-native-async-storage/async-storage：pnpm add @react-native-async-storage/async-storage",
    );
  }
}

function readPlatform() {
  try {
    const mod = require("react-native") as { Platform?: { OS?: string } };
    const os = mod.Platform?.OS;
    if (os === "ios" || os === "android") return os;
    if (os) console.warn(`[PayLens] 当前平台 ${os} 不在 V0.1 支持范围内`);
  } catch {
    // 测试环境没有 react-native。
  }
  return "ios";
}

function watchBackground(onBackground: () => void) {
  try {
    const mod = require("react-native") as {
      AppState?: { addEventListener: (type: string, listener: (state: string) => void) => { remove: () => void } };
    };
    const subscription = mod.AppState?.addEventListener("change", (state) => {
      if (state === "background" || state === "inactive") onBackground();
    });
    return () => subscription?.remove();
  } catch {
    return () => undefined;
  }
}

export function createPayLens(deps: PayLensDeps = {}) {
  let storageRef = deps.storage;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? createEventId;
  const readAppVersion = deps.readAppVersion ?? readExpoApplicationVersion;
  const platform = deps.platform ?? readPlatform();
  const autoFlush = deps.autoFlush ?? true;
  const baseBackoffMs = deps.initialBackoffMs ?? 1000;
  let backoffMs = baseBackoffMs;

  let options: PayLensOptions | null = null;
  let anonymousUserId = "";
  let queue: QueuedEvent[] = [];
  let session: SessionState = null;
  let pausedKey: string | null = null;
  let pending = Promise.resolve();
  let flushing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopWatch = () => undefined as void;

  function remember(work: () => Promise<void>) {
    pending = pending.then(work, work);
    return pending;
  }

  async function persist() {
    if (!storageRef) return;
    const snapshot: PersistedState = { anonymousUserId, queue, session, pausedKey };
    await storageRef.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }

  function schedule(delay: number) {
    if (!autoFlush) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flushOnce();
    }, delay);
  }

  async function flushOnce() {
    if (!options || pausedKey === options.clientKey || flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue.slice(0, BATCH_SIZE);
    const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
    try {
      const response = await fetchImpl(`${endpoint}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.clientKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: batch }),
      });
      if (response.status === 401) {
        const body = (await response.json().catch(() => ({}))) as { error_code?: string };
        if (body.error_code === "key_revoked") {
          pausedKey = options.clientKey;
          await persist();
          console.warn("[PayLens] Client Key 已撤销，已停止这把 key 的重试。队列仍保留在本地。");
          return;
        }
        schedule(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        return;
      }
      if (response.status === 400 || response.status === 413) {
        queue.splice(0, batch.length);
        await persist();
        console.warn("[PayLens] 这一批事件被服务器拒绝，已丢弃，不会按原请求重试。");
        backoffMs = baseBackoffMs;
        return;
      }
      if (response.status === 429 || response.status === 408 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = response.status === 429 && Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs;
        schedule(delay);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        return;
      }
      if (!response.ok) {
        schedule(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        return;
      }
      await response.json().catch(() => ({}));
      queue.splice(0, batch.length);
      await persist();
      backoffMs = baseBackoffMs;
    } catch {
      schedule(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    } finally {
      flushing = false;
      if (queue.length > 0 && options && pausedKey !== options.clientKey && backoffMs === baseBackoffMs) {
        void flushOnce();
      }
    }
  }

  return {
    init(next: PayLensOptions) {
      if (!next.clientKey) throw new Error("PayLens.init 需要 clientKey");
      if (!storageRef) storageRef = loadAsyncStorage();
      options = next;
      remember(async () => {
        const saved = await storageRef?.getItem(STORAGE_KEY);
        if (saved) {
          try {
            const parsed = JSON.parse(saved) as PersistedState;
            anonymousUserId = parsed.anonymousUserId || anonymousUserId;
            queue = parsed.queue ?? [];
            session = parsed.session ?? null;
            pausedKey = parsed.pausedKey ?? null;
          } catch {
            console.warn("[PayLens] 本地队列无法读取，已重新开始");
          }
        }
        if (!anonymousUserId) anonymousUserId = createId();
        if (pausedKey && pausedKey !== next.clientKey) pausedKey = null;
        await persist();
      });
      if (autoFlush && !interval) {
        interval = setInterval(() => void flushOnce(), FLUSH_EVERY_MS);
        stopWatch = watchBackground(() => void flushOnce()) ?? (() => undefined);
      }
    },
    track(eventName: EventName, extra?: { productId?: string; paywallVersion?: string }) {
      remember(async () => {
        if (!options) {
          console.warn("[PayLens] 请先调用 init");
          return;
        }
        const occurred = now();
        const decision = applyTrack({
          state: session,
          eventName,
          now: occurred.getTime(),
          createId,
          defaultPaywallVersion: options.paywallVersion ?? null,
          paywallVersion: extra?.paywallVersion,
        });
        session = decision.state;
        if (decision.warn) console.warn(`[PayLens] ${decision.warn}`);
        if (!decision.sessionId) {
          await persist();
          return;
        }
        const event: QueuedEvent = {
          event_id: createId(),
          event_name: eventName,
          anonymous_user_id: anonymousUserId,
          paywall_session_id: decision.sessionId,
          platform,
          app_version: resolveAppVersion(options.appVersion, readAppVersion),
          occurred_at: occurred.toISOString(),
        };
        if (decision.paywallVersion) event.paywall_version = decision.paywallVersion;
        if (extra?.productId && (eventName === "subscribe_clicked" || eventName === "purchase_success")) {
          event.product_id = extra.productId;
        }
        queue.push(event);
        if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
        await persist();
        if (autoFlush && queue.length >= 10) void flushOnce();
      });
    },
    async flush() {
      await pending;
      await flushOnce();
    },
    debugState() {
      return { queue: [...queue], session, pausedKey, anonymousUserId };
    },
    stop() {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      stopWatch();
    },
  };
}

const singleton = createPayLens();

export const PayLens = {
  init(options: PayLensOptions) {
    singleton.init(options);
  },
  track(eventName: EventName, extra?: { productId?: string; paywallVersion?: string }) {
    singleton.track(eventName, extra);
  },
  flush() {
    return singleton.flush();
  },
};
