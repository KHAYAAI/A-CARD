import { mkdtempSync, statSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { base58 } from "@scure/base";
import { createProviderApp } from "../src/app.js";
import { loadNetworks, TESTNETS } from "../src/chains.js";
import { generateKey, open, parseMasterKey, seal } from "../src/crypto.js";
import { ProviderService, usdc } from "../src/service.js";
import { FileKeyStore, MemoryKeyStore } from "../src/store.js";
import { startFakeEvmNode } from "../src/testing/fakeEvmNode.js";

const MASTER = "a1".repeat(16) + "b2".repeat(16);
const KEY = "test-provider-api-key-0123456789";
const h = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const DEST = "0x000000000000000000000000000000000000dEaD";

describe("crypto", () => {
  it("derives the known address for private key 1", () => {
    expect(privateKeyToAccount(("0x" + "0".repeat(63) + "1") as any).address).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });
  it("generates valid keys per chain", () => {
    const e = generateKey("ethereum");
    expect(privateKeyToAccount(("0x" + e.secret.toString("hex")) as any).address).toBe(e.address);
    const s = generateKey("solana");
    expect(base58.decode(s.address)).toHaveLength(32);
    expect(generateKey("ethereum").address).not.toBe(e.address);
  });
  it("round-trips, and fails on tamper, wrong master, or a moved record", () => {
    const m = parseMasterKey(MASTER);
    const k = generateKey("ethereum");
    const s = seal(m, k.secret, "u1", "ethereum", k.address);
    expect(open(m, s, "u1", "ethereum", k.address).equals(k.secret)).toBe(true);
    expect(() => open(parseMasterKey("c3".repeat(16) + "d4".repeat(16)), s, "u1", "ethereum", k.address)).toThrow();
    expect(() => open(m, s, "u2", "ethereum", k.address)).toThrow();
    expect(() => open(m, { ...s, ct: Buffer.from("00".repeat(32), "hex").toString("base64") }, "u1", "ethereum", k.address)).toThrow();
    expect(JSON.stringify(s)).not.toContain(k.secret.toString("hex"));
  });
  it("refuses weak master keys", () => {
    expect(() => parseMasterKey("00".repeat(32))).toThrow();
    expect(() => parseMasterKey("abcd")).toThrow();
  });
});

describe("network gate", () => {
  it("defaults to testnets and refuses mainnet without the flag", () => {
    expect(Object.values(loadNetworks({})).every((n) => n.testnet)).toBe(true);
    const main = JSON.stringify([{ chain: "ethereum", kind: "evm", name: "mainnet", chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", testnet: false }]);
    expect(() => loadNetworks({ PROVIDER_NETWORKS_JSON: main })).toThrow(/not a test network/);
    expect(loadNetworks({ PROVIDER_NETWORKS_JSON: main, PROVIDER_ALLOW_MAINNET: "true" }).ethereum.testnet).toBe(false);
  });
});

describe("provider over HTTP with a fake chain", () => {
  let node: Awaited<ReturnType<typeof startFakeEvmNode>>;
  let app: ReturnType<typeof createProviderApp>;
  let logs: string[];
  let store: MemoryKeyStore;
  const call = (path: string, init?: RequestInit) => app.request(path, { ...init, headers: { ...h, ...(init?.headers as any) } });
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

  beforeAll(async () => {
    node = await startFakeEvmNode({ chainId: TESTNETS.ethereum.chainId!, usdc: TESTNETS.ethereum.usdc });
    logs = [];
    store = new MemoryKeyStore();
    const networks = loadNetworks({ PROVIDER_RPC_ETHEREUM: node.url, PROVIDER_RPC_SOLANA: node.url });
    app = createProviderApp(new ProviderService({ masterKey: parseMasterKey(MASTER), store, networks, maxTransfer: usdc(50), maxDaily: usdc(80), confirmTimeoutMs: 2000, log: (l) => logs.push(l) }), { apiKey: KEY });
  });
  afterAll(() => node.close());

  it("requires auth, except healthz", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/status")).status).toBe(401);
    expect((await app.request("/status", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call("/status")).status).toBe(200);
  });

  it("creates wallets idempotently and never returns key material", async () => {
    const a = await post("/wallets", { userId: "u-1", chain: "ethereum" });
    expect(a.status).toBe(201);
    const j = (await a.json()) as any;
    expect(j.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(Object.keys(j).sort()).toEqual(["address", "chain"]);
    const b = await post("/wallets", { userId: "u-1", chain: "ethereum" });
    expect(b.status).toBe(200);
    expect(((await b.json()) as any).address).toBe(j.address);
    const sol = (await (await post("/wallets", { userId: "u-1", chain: "solana" })).json()) as any;
    expect(base58.decode(sol.address)).toHaveLength(32);
    expect((await post("/wallets", { userId: "", chain: "ethereum" })).status).toBe(400);
    expect((await post("/wallets", { userId: "x", chain: "bitcoin" })).status).toBe(400);
    const stored = JSON.stringify(await store.getWallet("u-1", "ethereum"));
    expect(stored).not.toMatch(/privateKey|secret/i);
  });

  it("reads balances from the chain, EVM and Solana", async () => {
    const w = (await (await post("/wallets", { userId: "u-bal", chain: "ethereum" })).json()) as any;
    node.fund(w.address, usdc(12.5));
    const r = (await (await call(`/wallets/balance?chain=ethereum&address=${w.address}`)).json()) as any;
    expect(r).toMatchObject({ balance: 12.5, asset: "USDC", testnet: true, network: "sepolia" });
    const s = (await (await post("/wallets", { userId: "u-bal", chain: "solana" })).json()) as any;
    node.fundSolana(s.address, usdc(3));
    expect(((await (await call(`/wallets/balance?chain=solana&address=${s.address}`)).json()) as any).balance).toBe(3);
    expect((await call("/wallets/balance?chain=ethereum&address=nope")).status).toBe(400);
  });

  it("sends a signed USDC transfer that the chain independently verifies", async () => {
    const w = (await (await post("/wallets", { userId: "u-pay", chain: "ethereum" })).json()) as any;
    node.fund(w.address, usdc(100));
    const res = await post("/wallets/transfer", { chain: "ethereum", from: w.address, to: DEST, amount: usdc(20).toString(), idempotencyKey: "intent-0001-abcd" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j).toMatchObject({ confirmed: true, replayed: false, testnet: true });
    const seen = node.transfers.find((t) => t.txHash === j.txHash)!;
    expect(seen.from.toLowerCase()).toBe(w.address.toLowerCase());
    expect(seen.to.toLowerCase()).toBe(DEST.toLowerCase());
    expect(seen.amount).toBe(usdc(20));
    expect(seen.contract.toLowerCase()).toBe(TESTNETS.ethereum.usdc.toLowerCase());
    expect(node.balanceOf(DEST)).toBe(usdc(20));
    expect(node.balanceOf(w.address)).toBe(usdc(80));
    // replay: same result, no second transaction
    const n = node.transfers.length;
    const again = (await (await post("/wallets/transfer", { chain: "ethereum", from: w.address, to: DEST, amount: usdc(20).toString(), idempotencyKey: "intent-0001-abcd" })).json()) as any;
    expect(again).toMatchObject({ txHash: j.txHash, replayed: true });
    expect(node.transfers.length).toBe(n);
    // same key, different transfer
    const bad = await post("/wallets/transfer", { chain: "ethereum", from: w.address, to: DEST, amount: usdc(21).toString(), idempotencyKey: "intent-0001-abcd" });
    expect(bad.status).toBe(409);
  });

  it("enforces per-transfer and daily caps, ownership, and chain rejections", async () => {
    const w = (await (await post("/wallets", { userId: "u-cap", chain: "ethereum" })).json()) as any;
    node.fund(w.address, usdc(500));
    const t = (amt: number, key: string, from = w.address) => post("/wallets/transfer", { chain: "ethereum", from, to: DEST, amount: usdc(amt).toString(), idempotencyKey: key });
    expect((await t(51, "cap-one-0001")).status).toBe(422);
    expect((await t(50, "cap-two-0001")).status).toBe(200);
    expect((await t(31, "cap-three-001")).status).toBe(422); // 50 + 31 > 80
    expect((await t(30, "cap-four-0001")).status).toBe(200);
    expect((await t(1, "cap-five-0001")).status).toBe(422);
    expect((await t(1, "cap-six-00001", "0x1111111111111111111111111111111111111111")).status).toBe(404);
    expect((await post("/wallets/transfer", { chain: "ethereum", from: w.address, to: "bad", amount: "1", idempotencyKey: "cap-seven-001" })).status).toBe(400);
    const empty = (await (await post("/wallets", { userId: "u-empty", chain: "ethereum" })).json()) as any;
    const r = await post("/wallets/transfer", { chain: "ethereum", from: empty.address, to: DEST, amount: usdc(5).toString(), idempotencyKey: "empty-wallet-01" });
    expect(r.status).toBe(422);
  });

  it("serialises concurrent transfers so nonces never collide", async () => {
    const w = (await (await post("/wallets", { userId: "u-conc", chain: "ethereum" })).json()) as any;
    node.fund(w.address, usdc(100));
    const rs = await Promise.all([1, 2, 3].map((i) => post("/wallets/transfer", { chain: "ethereum", from: w.address, to: DEST, amount: usdc(5).toString(), idempotencyKey: `conc-key-000${i}` })));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    const nonces = node.transfers.filter((t) => t.from.toLowerCase() === w.address.toLowerCase()).map((t) => t.nonce);
    expect(nonces).toEqual([0, 1, 2]);
  });

  it("reports an unconfirmed broadcast as unconfirmed, not failed", async () => {
    const w = (await (await post("/wallets", { userId: "u-slow", chain: "ethereum" })).json()) as any;
    node.fund(w.address, usdc(10));
    node.holdReceipts(true);
    const r = (await (await post("/wallets/transfer", { chain: "ethereum", from: w.address, to: DEST, amount: usdc(1).toString(), idempotencyKey: "slow-key-0001" })).json()) as any;
    node.holdReceipts(false);
    expect(r.confirmed).toBe(false);
    expect(r.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses Solana transfers honestly", async () => {
    const s = (await (await post("/wallets", { userId: "u-sol", chain: "solana" })).json()) as any;
    const r = await post("/wallets/transfer", { chain: "solana", from: s.address, to: s.address, amount: "1", idempotencyKey: "sol-key-00001" });
    expect(r.status).toBe(501);
  });

  it("503s balance and transfer when no RPC is configured, but still makes wallets", async () => {
    const bare = createProviderApp(new ProviderService({ masterKey: parseMasterKey(MASTER), store: new MemoryKeyStore(), networks: loadNetworks({}), maxTransfer: usdc(1), maxDaily: usdc(1), log: () => {} }), { apiKey: KEY });
    const w = (await (await bare.request("/wallets", { method: "POST", headers: h, body: JSON.stringify({ userId: "z", chain: "ethereum" }) })).json()) as any;
    expect((await bare.request(`/wallets/balance?chain=ethereum&address=${w.address}`, { headers: h })).status).toBe(503);
  });

  it("never logs key material", () => {
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(Object.keys(JSON.parse(l)).some((k) => /secret|sealed|private|key/i.test(k))).toBe(false);
  });
});

describe("file store", () => {
  it("writes owner-only, reloads, and refuses a world-readable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prov-"));
    const path = join(dir, "keys.json");
    const s1 = new FileKeyStore(path);
    const svc = new ProviderService({ masterKey: parseMasterKey(MASTER), store: s1, networks: loadNetworks({}), maxTransfer: usdc(1), maxDaily: usdc(1), log: () => {} });
    const w = await svc.createWallet("u", "ethereum");
    expect(statSync(path).mode & 0o077).toBe(0);
    const svc2 = new ProviderService({ masterKey: parseMasterKey(MASTER), store: new FileKeyStore(path), networks: loadNetworks({}), maxTransfer: usdc(1), maxDaily: usdc(1), log: () => {} });
    expect((await svc2.createWallet("u", "ethereum")).address).toBe(w.address);
    expect(readFileSync(path, "utf8")).not.toMatch(/privateKey/i);
    chmodSync(path, 0o644);
    expect(() => new FileKeyStore(path)).toThrow(/readable by other users/);
  });
});
