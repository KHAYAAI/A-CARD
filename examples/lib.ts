import { pathToFileURL } from "node:url";
import { Acard } from "@acard/sdk";

/**
 * Shared plumbing for the examples: where the API is, which key to use, and a
 * tiny logger. Every example can run against any A-CARD deployment — by
 * default the local sandbox from `npm run dev:api`.
 */

export interface ExampleOptions {
  baseUrl?: string;
  apiKey?: string;
  log?: (line: string) => void;
}

export const DEFAULT_BASE_URL = "http://localhost:8787";

export function resolveOptions(options: ExampleOptions = {}) {
  return {
    baseUrl: options.baseUrl ?? process.env.ACARD_API_URL ?? DEFAULT_BASE_URL,
    apiKey: options.apiKey ?? process.env.ACARD_API_KEY,
    log: options.log ?? ((line: string) => console.log(line)),
  };
}

/** A client for the given key — or, with no key, a fresh sandbox organization. */
export async function connect(options: ExampleOptions = {}): Promise<{ acard: Acard; apiKey: string; baseUrl: string }> {
  const { baseUrl, apiKey, log } = resolveOptions(options);
  if (apiKey) return { acard: new Acard({ apiKey, baseUrl }), apiKey, baseUrl };
  const signup = await Acard.signup(
    { email: `example-${Date.now()}@khaya.example`, name: "Khaya Logistics", currency: "ZAR", account_type: "enterprise" },
    { baseUrl },
  );
  log(`No ACARD_API_KEY set — signed up a fresh sandbox org (${signup.account_holder.id}).`);
  return { acard: new Acard({ apiKey: signup.api_key, baseUrl }), apiKey: signup.api_key, baseUrl };
}

/** Rands (or dollars) from integer cents, for printing. */
export function money(cents: number, currency = "ZAR"): string {
  const symbol = currency === "ZAR" ? "R" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Run `main` when the file is executed directly (`npx tsx file.ts`), not when imported by tests. */
export function runIfMain(metaUrl: string, main: () => Promise<unknown>): void {
  if (process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
      process.exitCode = 1;
    });
  }
}

/** Calls the REST API directly, for operator endpoints the SDK doesn't wrap. */
export async function rest<T = any>(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${json?.error?.code ?? ""}: ${json?.error?.message ?? ""}`);
  return json as T;
}
