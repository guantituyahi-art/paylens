import { randomUUID } from "node:crypto";

export type FactClass = "measured" | "direct" | "behavioral";

export type Envelope<R> = {
  evidence_id: string;
  tool: string;
  tool_version: string;
  args: object;
  timezone: string;
  as_of: string;
  data_through: string;
  definitions: Record<string, string>;
  sample: {
    unit: "paywall_session" | "install" | "feedback" | "subscription";
    n: number;
    required: number;
    status: "ok" | "low_sample" | "insufficient";
  };
  result: R;
  facts: Array<{ id: string; class: FactClass; text: string; source: string }>;
  caveats: string[];
};

export const TOOL_VERSION = "1";

export function evidenceId() {
  return `ev_${randomUUID().slice(0, 8)}`;
}

export function sampleStatus(n: number, required: number): Envelope<unknown>["sample"]["status"] {
  if (n < 30) return "insufficient";
  if (n < required) return "low_sample";
  return "ok";
}

export function makeEnvelope<R>(input: {
  tool: string;
  args: object;
  timezone: string;
  asOf: Date;
  dataThrough: string;
  definitions: Record<string, string>;
  sample: Envelope<R>["sample"];
  result: R;
  facts: Envelope<R>["facts"];
  caveats: string[];
}): Envelope<R> {
  return {
    evidence_id: evidenceId(),
    tool: input.tool,
    tool_version: TOOL_VERSION,
    args: input.args,
    timezone: input.timezone,
    as_of: input.asOf.toISOString(),
    data_through: input.dataThrough,
    definitions: input.definitions,
    sample: input.sample,
    result: input.result,
    facts: input.facts,
    caveats: input.caveats,
  };
}
