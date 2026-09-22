export type JsonSchema = Record<string, unknown>;

export interface AiProvider {
  readonly model: string;
  generateStructured<T>(input: { system: string; user: string; schema: JsonSchema; name: string }): Promise<T>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function createAiProviderFromEnv(): AiProvider | null {
  const provider = process.env.AI_PROVIDER?.trim();
  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!provider && !apiKey && !model) return null;
  if (provider !== "openai" || !apiKey || !model) return null;
  const baseUrl = (process.env.AI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  return {
    model,
    async generateStructured<T>(input: { system: string; user: string; schema: JsonSchema; name: string }) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: input.name, strict: true, schema: input.schema },
          },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) {
        throw new Error(`AI 请求失败（HTTP ${response.status}）`);
      }
      const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("AI 没有返回 JSON");
      }
      return JSON.parse(content) as T;
    },
  };
}
