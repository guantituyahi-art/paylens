import { randomBytes } from "node:crypto";

const KEY_PREFIX = "pl_pub_";
const KEY_BODY_LENGTH = 32;

export function generateClientKey() {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

export function isClientKeyShape(value: string) {
  return new RegExp(`^${KEY_PREFIX}[A-Za-z0-9_-]{${KEY_BODY_LENGTH}}$`).test(value);
}
