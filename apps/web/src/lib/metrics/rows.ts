export function queryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) {
    return result.rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  return [];
}

export function textCell(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

export function intCell(value: unknown) {
  return Number(value ?? 0);
}
