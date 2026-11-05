import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WalletService } from "../src/wallet.js";
import { DevSigner, OpenFireblocksSigner } from "../src/signer/index.js";
import { MockChain } from "../src/chains/mock.js";
import { MockSwapProvider } from "../src/swap.js";
import { SandboxDefiProvider } from "../src/defi.js";
import type { WalletPolicy } from "../src/policy/engine.js";
import type { ForgePayEvent } from "../src/events.js";
import { USDC_BY_NETWORK } from "../src/x402/protocol.js";

const SEPOLIA = "eip155:84532";
const USDC = USDC_BY_NETWORK[SEPOLIA]!.address;
const PAY_TO = "0x1111111111111111111111111111111111111111";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const unb64 = (v: string) => JSON.parse(Buffer.from(v, "base64").toString("utf8"));

interface Counterparty {
  url: string;
  host: string;
  unpaid: number;
  paid: Array<Record<string, any>>;
  close: () => void;
}

async function counterparty(opts: { price: string; version?: 1 | 2; onPaid?: "ok" | "reject" | "error" }): Promise<Counterparty> {
  const state = { unpaid: 0, paid: [] as Array<Record<string, any>> };
  const requirement =
    opts.version === 1
      ? { scheme: "exact", network: "base-sepolia", maxAmountRequired: opts.price, resource: "http://x/y", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }
      : { scheme: "exact", network: SEPOLIA, amount: opts.price, asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
  const server: Server = createServer((req, res) => {
    const header = (opts.version === 1 ? req.headers["x-payment"] : req.headers["payment-signature"]) as string | undefined;
    if (!header) {
      state.unpaid++;
      if (opts.version === 1) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ x402Version: 1, accepts: [requirement] }));
      }
      res.writeHead(402, { "payment-required": b64({ x402Version: 2, accepts: [requirement] }) });
      return res.end("{}");
    }
    state.paid.push(unb64(header));
    if (opts.onPaid === "reject") {
      res.writeHead(402, { "payment-response": b64({ success: false, errorReason: "invalid_payload" }) });
      return res.end("{}");
    }
    if (opts.onPaid === "error") {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json", [opts.version === 1 ? "x-payment-response" : "payment-response"]: b64({ success: true, transaction: "0xfeed", network: SEPOLIA }) });
    res.end(JSON.stringify({ forecast: "clear", temp: 24 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/weather`,
    host: "127.0.0.1",
    get unpaid() {
      return state.unpaid;
    },
    get paid() {
      return state.paid;
    },
    close: () => server.close(),
  };
}

const policy: WalletPolicy = {
  allowedChains: ["mock"],
  assets: { USDC: { perTx: 50_000_000n, per24h: 200_000_000n, approvalAbove: 10_000_000n }, ZARP: { perTx: 5_000_000_000n, per24h: 5_000_000_000n } },
  x402: { maxPricePerRequest: 1_000_000n },
  swap: { maxSlippageBps: 100 },
};

let events: ForgePayEvent[];
let chain: MockChain;
let signer: DevSigner;
let wallet: WalletService;
let cp: Counterparty | undefined;
let me: string;

async function build(overrides: Partial<ConstructorParameters<typeof WalletService>[0]> = {}, p: WalletPolicy = policy) {
  events = [];
  chain = new MockChain();
  signer = new DevSigner();
  wallet = new WalletService({
    agentId: "a1",
    signer,
    chain,
    policies: { w: p },
    sanctions: async () => "clear",
    sink: (e) => void events.push(e),
    swap: new MockSwapProvider(chain),
    defi: new SandboxDefiProvider(),
    x402: { networks: { [SEPOLIA]: "mock" }, allowPrivateNetworks: true },
    ...overrides,
  });
  me = await signer.address("mock");
  chain.credit(me, "USDC", 100_000_000n);
}

beforeEach(async () => build());
afterEach(() => {
  cp?.close();
  cp = undefined;
});

describe("x402", () => {
  it("previews the price, pays a v2 server, returns the resource, and debits the wallet", async () => {
    cp = await counterparty({ price: "25000" });
    const p = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 100_000n });
    expect(p.policy.decision).toBe("allow");
    expect(p.request).toMatchObject({ asset: "USDC", amount: 25_000n, to: PAY_TO });
    expect(cp.paid).toHaveLength(0); // previewing pays nothing

    const r = await wallet.x402Pay(p.id);
    expect(r).toMatchObject({ status: 200, txHash: "0xfeed" });
    expect(JSON.parse(r.body!)).toEqual({ forecast: "clear", temp: 24 });
    expect(cp.paid[0]!.payload.authorization).toMatchObject({ from: me, to: PAY_TO, value: "25000" });
    expect(chain.balance(me, "USDC")).toBe(100_000_000n - 25_000n);
    expect(events.map((e) => e.type)).toEqual(["agent_wallet.x402.previewed", "agent_wallet.x402.paid"]);
    await expect(wallet.x402Pay(p.id)).rejects.toThrow("preview_already_used");
  });

  it("speaks v1 too", async () => {
    cp = await counterparty({ price: "10000", version: 1 });
    const p = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 100_000n });
    expect((await wallet.x402Pay(p.id)).status).toBe(200);
    expect(cp.paid[0]).toMatchObject({ x402Version: 1, network: "base-sepolia" });
  });

  it("refuses a price above the agent's max, without paying", async () => {
    cp = await counterparty({ price: "50000" });
    const p = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 10_000n });
    expect(p).toMatchObject({ policy: { decision: "deny", reasons: ["x402_price_above_max"] } });
    await expect(wallet.x402Pay(p.id)).rejects.toThrow("denied:x402_price_above_max");
    expect(cp.paid).toHaveLength(0);
  });

  it("refuses a price above the wallet's own per-request cap even if the agent allows it", async () => {
    cp = await counterparty({ price: "2000000" }); // $2, cap is $1
    const p = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 5_000_000n });
    expect(p.policy.reasons).toEqual(["x402_price_above_policy_max"]);
  });

  it("is off unless the wallet's policy enables it, and never contacts a host it isn't allowed to", async () => {
    cp = await counterparty({ price: "1000" });
    await build({}, { ...policy, x402: undefined });
    expect((await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 1_000n })).policy.reasons).toEqual(["x402_not_enabled"]);

    await build({}, { ...policy, x402: { maxPricePerRequest: 1_000_000n, allowedDomains: ["api.freight-data.example", ".trusted.example"] } });
    const denied = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 1_000n });
    expect(denied.policy.reasons).toEqual(["x402_domain_not_allowed:127.0.0.1"]);
    expect(cp.unpaid).toBe(0); // the host was never contacted
  });

  it("refuses private-network and non-HTTPS URLs unless the sandbox opts out", async () => {
    await build({ x402: { networks: { [SEPOLIA]: "mock" } } });
    await expect(wallet.x402Preview({ walletId: "w", url: "http://127.0.0.1:9/x", maxAmount: 1n })).rejects.toThrow(/x402_url_not_allowed/);
    await expect(wallet.x402Preview({ walletId: "w", url: "https://169.254.169.254/latest", maxAmount: 1n })).rejects.toThrow(/private/);
  });

  it("an approval above the wallet's threshold is required; the same preview pays once approved", async () => {
    cp = await counterparty({ price: "800000" });
    await build({}, { ...policy, assets: { ...policy.assets, USDC: { perTx: 50_000_000n, per24h: 200_000_000n, approvalAbove: 500_000n } } });
    const p = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 1_000_000n });
    expect(p.policy.decision).toBe("require_approval");
    await expect(wallet.x402Pay(p.id)).rejects.toThrow("approval_required");
    expect(cp.paid).toHaveLength(0);
    wallet.decideApproval(p.approvalId!, true);
    expect((await wallet.x402Pay(p.id)).status).toBe(200);
  });

  it("a refused payment debits nothing; a server error after signing is 'unknown', also debiting nothing", async () => {
    cp = await counterparty({ price: "1000", onPaid: "reject" });
    const p = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 5_000n });
    await expect(wallet.x402Pay(p.id)).rejects.toThrow("x402_payment_rejected:402:invalid_payload");
    expect(chain.balance(me, "USDC")).toBe(100_000_000n);
    cp.close();

    cp = await counterparty({ price: "1000", onPaid: "error" });
    const p2 = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 5_000n });
    await expect(wallet.x402Pay(p2.id)).rejects.toThrow("x402_outcome_unknown");
    expect(chain.balance(me, "USDC")).toBe(100_000_000n);
    expect(events.at(-1)!.type).toBe("agent_wallet.x402.failed");
  });

  it("won't pay more than the wallet holds", async () => {
    cp = await counterparty({ price: "900000" });
    chain.debit(me, "USDC", 100_000_000n - 100_000n);
    const p = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 1_000_000n });
    await expect(wallet.x402Pay(p.id)).rejects.toThrow("insufficient_funds");
    expect(cp.paid).toHaveLength(0);
  });

  it("a transfer preview can't be used as an x402 payment, or the reverse", async () => {
    const t = await wallet.sendPreview({ walletId: "w", chain: "mock", asset: "USDC", to: "bob", amount: 1n });
    await expect(wallet.x402Pay(t.id)).rejects.toThrow("unknown_preview");
    cp = await counterparty({ price: "1000" });
    const x = await wallet.x402Preview({ walletId: "w", url: cp.url, maxAmount: 5_000n });
    await expect(wallet.sendExecute(x.id)).rejects.toThrow("unknown_preview");
  });
});

describe("swaps and DeFi reads", () => {
  const swap = { walletId: "w", chain: "mock" as const, assetIn: "USDC", assetOut: "ZARP", amountIn: 5_000_000n };

  it("quotes, then swaps at the quoted rate", async () => {
    const q = await wallet.swapQuote(swap);
    expect(q).toMatchObject({ policy: { decision: "allow" }, quote: { amountOut: 92_500_000n } }); // 5 × 18.5
    const r = await wallet.swapExecute(q.id);
    expect(r.amountOut).toBe(92_500_000n);
    expect(chain.balance(me, "USDC")).toBe(95_000_000n);
    expect(chain.balance(me, "ZARP")).toBe(92_500_000n);
    expect(events.map((e) => e.type)).toEqual(["agent_wallet.swap.previewed", "agent_wallet.swap.executed"]);
    await expect(wallet.swapExecute(q.id)).rejects.toThrow("preview_already_used");
  });

  it("the input amount counts against the asset's limits and approval threshold", async () => {
    expect((await wallet.swapQuote({ ...swap, amountIn: 20_000_000n })).policy.decision).toBe("require_approval");
    expect((await wallet.swapQuote({ ...swap, amountIn: 90_000_000n })).policy.reasons).toEqual(["exceeds_per_tx_limit"]);
  });

  it("enforces the pair list and the slippage bound, and is off without a swap policy", async () => {
    await build({}, { ...policy, swap: { maxSlippageBps: 100, allowedPairs: ["USDC>ZARP"] } });
    expect((await wallet.swapQuote({ ...swap, assetIn: "ZARP", assetOut: "USDC", amountIn: 1_000n })).policy.reasons).toEqual(["pair_not_allowed:ZARP>USDC"]);

    await build({ swap: new MockSwapProvider(chain, undefined, 300n) }, policy); // provider allows 3% slippage, policy only 1%
    expect((await wallet.swapQuote(swap)).policy.reasons).toEqual(["slippage_above_policy"]);

    await build({}, { ...policy, swap: undefined });
    expect((await wallet.swapQuote(swap)).policy.reasons).toEqual(["swaps_not_enabled"]);
  });

  it("an unroutable pair is an error, and an expired quote can't be executed", async () => {
    await expect(wallet.swapQuote({ ...swap, assetOut: "DOGE" })).rejects.toThrow("no_route");
    let t = 1_000_000;
    await build({ swap: new MockSwapProvider(chain, undefined, 50n, () => t) });
    const q = await wallet.swapQuote(swap);
    t += 120_000; // past the 60 s quote
    await expect(wallet.swapExecute(q.id)).rejects.toThrow("quote_expired");
  });

  it("reads DeFi positions; the sandbox has none", async () => {
    expect(await wallet.defiPositions("mock")).toEqual([]);
  });
});

describe("mainnet gate", () => {
  it("denies mainnet unless the signer is openfireblocks AND mainnet is explicitly enabled", async () => {
    const mainnet: WalletPolicy = { ...policy, allowedChains: ["base"] };
    const req = { walletId: "w", chain: "base" as const, asset: "USDC", to: "bob", amount: 1n };
    await build({}, mainnet);
    expect((await wallet.sendPreview(req)).policy.reasons).toEqual(["mainnet_disabled"]);

    const fake = { id: "openfireblocks", address: async () => "0xvault", sign: async () => ({ chain: "base" as const, payload: new Uint8Array(), signature: "00", signerId: "openfireblocks" }) };
    await build({ signer: fake, allowMainnet: false }, mainnet);
    expect((await wallet.sendPreview(req)).policy.reasons).toEqual(["mainnet_disabled"]);
    await build({ signer: fake, allowMainnet: true }, mainnet);
    expect((await wallet.sendPreview(req)).policy.decision).toBe("allow");
    await build({ allowMainnet: true }, mainnet); // the dev signer can never unlock it
    expect((await wallet.sendPreview(req)).policy.reasons).toEqual(["mainnet_disabled"]);
  });
});

describe("OpenFireblocksSigner (against a local stand-in for the service)", () => {
  async function service(mode: "instant" | "quorum" | "rejected" | "stuck") {
    const seen: Array<{ path: string; auth?: string; body?: any }> = [];
    let polls = 0;
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({ path: `${req.method} ${req.url}`, auth: req.headers.authorization, body });
        res.setHeader("content-type", "application/json");
        if (req.method === "GET" && req.url === "/v1/vaults/v1/addresses/base-sepolia") return res.end(JSON.stringify({ address: "0xvault" }));
        if (req.method === "POST" && req.url === "/v1/vaults/v1/sign") {
          if (mode === "instant") return res.end(JSON.stringify({ signature: "ab12" }));
          res.writeHead(202);
          return res.end(JSON.stringify({ request_id: "req_1" }));
        }
        if (req.url === "/v1/sign-requests/req_1") {
          polls++;
          if (mode === "rejected") return res.end(JSON.stringify({ status: "rejected" }));
          if (mode === "stuck") return res.end(JSON.stringify({ status: "pending" }));
          return res.end(JSON.stringify(polls < 3 ? { status: "pending" } : { status: "signed", signature: "cd34" }));
        }
        res.writeHead(404);
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { baseUrl, seen, close: () => server.close() };
  }

  it("fetches the vault address once, and signs with a bearer token without exposing it", async () => {
    const svc = await service("instant");
    try {
      const signer = new OpenFireblocksSigner({ baseUrl: svc.baseUrl, vaultId: "v1", token: "secret-token" });
      expect(await signer.address("base-sepolia")).toBe("0xvault");
      await signer.address("base-sepolia");
      expect(svc.seen.filter((s) => s.path.includes("addresses"))).toHaveLength(1);
      const signed = await signer.sign({ chain: "base-sepolia", payload: new Uint8Array([1, 2, 3]) });
      expect(signed).toMatchObject({ signature: "ab12", signerId: "openfireblocks" });
      expect(svc.seen.at(-1)!.body).toMatchObject({ chain: "base-sepolia", payload: "010203" });
      expect(svc.seen.every((s) => s.auth === "Bearer secret-token")).toBe(true);
      expect(JSON.stringify(signer)).not.toContain("secret-token");
    } finally {
      svc.close();
    }
  });

  it("waits for co-signers when the service answers 202, and surfaces a rejection", async () => {
    const quorum = await service("quorum");
    try {
      const signer = new OpenFireblocksSigner({ baseUrl: quorum.baseUrl, vaultId: "v1", token: "t", pollIntervalMs: 5 });
      expect((await signer.sign({ chain: "base-sepolia", payload: new Uint8Array() })).signature).toBe("cd34");
    } finally {
      quorum.close();
    }
    const rejected = await service("rejected");
    try {
      const signer = new OpenFireblocksSigner({ baseUrl: rejected.baseUrl, vaultId: "v1", token: "t", pollIntervalMs: 5 });
      await expect(signer.sign({ chain: "base-sepolia", payload: new Uint8Array() })).rejects.toThrow("co-signers rejected");
    } finally {
      rejected.close();
    }
  });

  it("times out rather than waiting forever", async () => {
    const quorum = await service("stuck");
    try {
      const signer = new OpenFireblocksSigner({ baseUrl: quorum.baseUrl, vaultId: "v1", token: "t", pollIntervalMs: 5, signTimeoutMs: 20 });
      await expect(signer.sign({ chain: "base-sepolia", payload: new Uint8Array() })).rejects.toThrow("timed out");
    } finally {
      quorum.close();
    }
  });
});
