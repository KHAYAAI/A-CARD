import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createProviderApp } from "../src/app.js";
import { loadNetworks, TESTNETS } from "../src/chains.js";
import { derToRs, spkiToPoint, type SigningBackend } from "../src/kmsSigner.js";
import { ProviderService, usdc } from "../src/service.js";
import { MemoryKeyStore } from "../src/store.js";
import { startFakeEvmNode } from "../src/testing/fakeEvmNode.js";

const KEY = "test-provider-api-key-0123456789";
const h = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const N = secp256k1.Point.CURVE().n;

/** Stands in for KMS: keys live only inside this closure, as they would in the HSM. */
function fakeKms(opts: { highS?: boolean } = {}) {
  const keys = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const be: SigningBackend = {
    name: "aws-kms",
    async createKey(tags) {
      const id = `key-${keys.size + 1}`;
      keys.set(id, secp256k1.utils.randomSecretKey());
      calls.push(`create ${JSON.stringify(tags)}`);
      return id;
    },
    async publicKey(id) {
      // Real KMS returns SPKI DER: a fixed 23-byte header then the point.
      return spkiToPoint(new Uint8Array([...new Uint8Array(23), ...secp256k1.getPublicKey(keys.get(id)!, false)]));
    },
    async signDigest(id, digest) {
      calls.push(`sign ${id}`);
      const sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, keys.get(id)!, { prehash: false, lowS: true }), "compact");
      // KMS does not normalise s; simulate the high-s half to prove we fix it.
      const s = opts.highS ? N - sig.s : sig.s;
      return new secp256k1.Signature(sig.r, s).toBytes("der");
    },
  };
  return { be, calls, keys };
}

describe("KMS signing", () => {
  let node: Awaited<ReturnType<typeof startFakeEvmNode>>;
  beforeAll(async () => {
    node = await startFakeEvmNode({ chainId: TESTNETS.ethereum.chainId!, usdc: TESTNETS.ethereum.usdc });
  });
  afterAll(() => node.close());

  const setup = (kms: ReturnType<typeof fakeKms>, store = new MemoryKeyStore()) => {
    const networks = loadNetworks({ PROVIDER_RPC_ETHEREUM: node.url, PROVIDER_RPC_SOLANA: node.url });
    const svc = new ProviderService({ signer: kms.be, store, networks, maxTransfer: usdc(50), maxDaily: usdc(80), confirmTimeoutMs: 2000, log: () => {} });
    return { app: createProviderApp(svc, { apiKey: KEY }), store, svc };
  };

  for (const highS of [false, true]) {
    it(`creates a KMS key per wallet and the chain accepts its signatures${highS ? " (high-s from KMS)" : ""}`, async () => {
      const kms = fakeKms({ highS });
      const { app, store } = setup(kms);
      const w = (await (await app.request("/wallets", { method: "POST", headers: h, body: JSON.stringify({ userId: "u1", chain: "ethereum" }) })).json()) as any;
      const rec = await store.getWallet("u1", "ethereum");
      expect(rec?.kms?.keyId).toBe("key-1");
      expect(rec?.sealed).toBeUndefined();
      expect(JSON.stringify(rec)).not.toMatch(/[0-9a-f]{64}/i);
      node.fund(w.address, usdc(10));
      const t = await app.request("/wallets/transfer", { method: "POST", headers: h, body: JSON.stringify({ chain: "ethereum", from: w.address, to: "0x000000000000000000000000000000000000dEaD", amount: "1000000", idempotencyKey: `kms-${highS}` }) });
      const body = (await t.json()) as any;
      expect(t.status, JSON.stringify(body)).toBe(200);
      expect(body.confirmed).toBe(true);
      expect(kms.calls).toEqual([`create {"acard:user":"u1","acard:chain":"ethereum"}`, "sign key-1"]);
    });
  }

  it("refuses Solana in KMS mode and local-key wallets without a master key", async () => {
    const { app, store } = setup(fakeKms());
    const r = await app.request("/wallets", { method: "POST", headers: h, body: JSON.stringify({ userId: "u2", chain: "solana" }) });
    expect(r.status).toBe(501);
    await store.putWallet({ id: "x", userId: "old", chain: "ethereum", address: "0x1111111111111111111111111111111111111111", sealed: {} as any, createdAt: "" });
    const t = await app.request("/wallets/transfer", { method: "POST", headers: h, body: JSON.stringify({ chain: "ethereum", from: "0x1111111111111111111111111111111111111111", to: "0x000000000000000000000000000000000000dEaD", amount: "1", idempotencyKey: "old-wallet-1" }) });
    expect(((await t.json()) as any).error?.code ?? "no_key_custody").toBeTruthy();
    expect(t.status).toBe(503);
  });

  it("parses DER and rejects junk", () => {
    expect(() => derToRs(new Uint8Array([1, 2, 3]))).toThrow();
    const sig = new secp256k1.Signature(5n, N - 7n).toBytes("der");
    expect(derToRs(sig)).toEqual({ r: 5n, s: 7n });
  });
});
