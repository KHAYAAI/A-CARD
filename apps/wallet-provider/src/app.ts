import { timingSafeEqual, createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ProviderError } from "./errors.js";
import type { ProviderService } from "./service.js";
import { isChain } from "./types.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function createProviderApp(svc: ProviderService, opts: { apiKey: string }) {
  if (opts.apiKey.length < 24) throw new Error("PROVIDER_API_KEY must be at least 24 characters");
  const want = digest(opts.apiKey);
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof ProviderError) return c.json({ error: { code: e.code, message: e.message } }, e.status as any);
    process.stderr.write(`unhandled: ${(e as Error).name}\n`);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/healthz") return next();
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1]!), want)) throw new ProviderError(401, "unauthorized", "missing or invalid bearer token");
    return next();
  });
  app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: { code: "too_large", message: "body too large" } }, 413) }));

  app.get("/status", (c) => c.json(svc.status()));

  app.post("/wallets", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { userId?: unknown; chain?: unknown };
    if (typeof b.userId !== "string" || !b.userId || b.userId.length > 128) throw new ProviderError(400, "bad_request", "userId is required");
    if (!isChain(b.chain)) throw new ProviderError(400, "bad_request", "chain must be ethereum, polygon or solana");
    const w = await svc.createWallet(b.userId, b.chain);
    return c.json({ address: w.address, chain: w.chain }, w.created ? 201 : 200);
  });

  app.get("/wallets/balance", async (c) => {
    const chain = c.req.query("chain");
    const address = c.req.query("address");
    if (!isChain(chain) || !address) throw new ProviderError(400, "bad_request", "address and chain are required");
    return c.json(await svc.balance(chain, address));
  });

  app.post("/wallets/transfer", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!isChain(b.chain)) throw new ProviderError(400, "bad_request", "chain must be ethereum, polygon or solana");
    for (const k of ["from", "to", "amount", "idempotencyKey"]) if (typeof b[k] !== "string") throw new ProviderError(400, "bad_request", `${k} is required`);
    const r = await svc.transfer({ chain: b.chain, from: b.from as string, to: b.to as string, amount: b.amount as string, idempotencyKey: b.idempotencyKey as string });
    return c.json({ ...r, network: svc.network(b.chain).name, testnet: svc.network(b.chain).testnet });
  });

  return app;
}
