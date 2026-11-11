/** The minimal slice of the Anthropic Messages API the sandbox uses. */

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface ModelMessage {
  role: "user" | "assistant";
  content: string | Block[];
}
export type Model = (req: { system: string; messages: ModelMessage[]; tools: ToolDef[]; base?: string }) => Promise<{ content: Block[] }>;

/** Claude over the Messages API, with a key the visitor supplied for this request. Never stored or logged. */
export function anthropicModel(opts: { apiKey: string; model: string; maxTokens?: number; baseUrl?: string }): Model {
  return async ({ system, messages, tools }) => {
    const res = await fetch(`${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1500,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(`model error ${res.status}: ${body?.error?.message ?? "unknown"}`);
    return { content: (body.content ?? []).filter((b: Block) => b.type === "text" || b.type === "tool_use") };
  };
}
