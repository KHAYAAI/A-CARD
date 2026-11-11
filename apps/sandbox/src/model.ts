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
export function anthropicModel(opts: { apiKey: string; model: string; maxTokens?: number; baseUrl?: string; /** Calling from a web page (the standalone build): the key goes from the visitor's browser straight to Anthropic. */ browserDirect?: boolean }): Model {
  return async ({ system, messages, tools }) => {
    const res = await fetch(`${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01", ...(opts.browserDirect ? { "anthropic-dangerous-direct-browser-access": "true" } : {}) },
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

/**
 * Verify a visitor's key with a one-token call, and explain a failure in plain words.
 * `browserDirect` is the standalone page calling Anthropic from the browser.
 */
export async function checkAnthropicKey(apiKey: string, opts: { baseUrl?: string; browserDirect?: boolean; model?: string } = {}): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", ...(opts.browserDirect ? { "anthropic-dangerous-direct-browser-access": "true" } : {}) },
      body: JSON.stringify({ model: opts.model ?? "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    if (res.ok) return { ok: true, message: "Key works. Live mode is ready." };
    const body = (await res.json().catch(() => ({}))) as any;
    const why = body?.error?.message ?? `status ${res.status}`;
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Anthropic rejected this key (${why}).` };
    if (res.status === 429) return { ok: false, message: "The key is valid but rate-limited or out of credit. Check your Anthropic account." };
    return { ok: false, message: `Anthropic returned an error: ${why}` };
  } catch {
    return { ok: false, message: opts.browserDirect ? "The browser couldn't reach Anthropic (offline, or the request was blocked)." : "The server couldn't reach Anthropic." };
  }
}
