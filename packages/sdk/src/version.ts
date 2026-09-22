export function resolveAppVersion(explicit: string | undefined, readNative: () => string | null) {
  const given = explicit?.trim();
  if (given) return given.slice(0, 32);
  const native = readNative()?.trim();
  if (native) return native.slice(0, 32);
  console.warn("[PayLens] 没有 appVersion，也没有读到 expo-application，已使用 unknown");
  return "unknown";
}

export function readExpoApplicationVersion() {
  try {
    const mod = require("expo-application") as { nativeApplicationVersion?: unknown };
    return typeof mod.nativeApplicationVersion === "string" ? mod.nativeApplicationVersion : null;
  } catch {
    return null;
  }
}

export function createEventId() {
  try {
    const mod = require("expo-crypto") as { randomUUID?: () => string };
    if (typeof mod.randomUUID === "function") return mod.randomUUID();
  } catch {
    // expo-crypto 是可选依赖。
  }
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
