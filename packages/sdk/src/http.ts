import { AcardError } from "./errors.js";

export interface HttpOptions {
  baseUrl: string;
  /** `ak_…` tenant key, `sess_…` session, or `mk_live_…` merchant key. */
  token: string;
  /** Automatic retries for network failures, 429 and 5xx. Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 30 000. */
  timeoutMs?: number;
  /** Bring your own fetch (tests, proxies, edge runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, with the two behaviours that make retries safe:
 *  - writes always carry an Idempotency-Key, generated once per call when the
 *    caller didn't supply one, and reused on every retry of that call;
 *  - only failures that can be retried are retried (network, 429, 5xx) —
 *    a 4xx means the request itself is wrong and resending it won't help.
 */
export class Http {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request<T>(
    method: Method,
    path: string,
    init: { body?: unknown; query?: Record<string, unknown>; idempotencyKey?: string; signal?: AbortSignal; auth?: boolean } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (init.auth !== false) headers.authorization = `Bearer ${this.options.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = init.idempotencyKey ?? crypto.randomUUID();

    const maxRetries = this.options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
      const onAbort = () => controller.abort();
      init.signal?.addEventListener("abort", onAbort);
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        });
      } catch (cause) {
        if (init.signal?.aborted) throw cause;
        if (attempt < maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new AcardError(0, "network_error", cause instanceof Error ? cause.message : String(cause));
      } finally {
        clearTimeout(timeout);
        init.signal?.removeEventListener("abort", onAbort);
      }

      const text = await response.text();
      const body = text ? safeJson(text) : undefined;
      if (response.ok) return body as T;

      const envelope = (body as { error?: { code?: string; message?: string; issues?: unknown[] } } | undefined)?.error;
      const error = new AcardError(
        response.status,
        envelope?.code ?? "unknown",
        envelope?.message ?? `request failed with status ${response.status}`,
        envelope?.issues,
        body,
      );
      if (error.retryable && attempt < maxRetries) {
        await sleep(backoff(attempt, response.headers.get("retry-after")));
        continue;
      }
      throw error;
    }
  }
}

function backoff(attempt: number, retryAfter?: string | null): number {
  const hinted = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(hinted) && hinted >= 0) return Math.min(hinted, 10_000);
  return Math.min(250 * 2 ** attempt, 4_000) + Math.floor(Math.random() * 100);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
