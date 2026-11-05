import { describe, it, expect, beforeEach } from "vitest";
import { WalletService } from "../src/wallet.js";
import { DevSigner } from "../src/signer/index.js";
import { MockChain } from "../src/chains/mock.js";
import { evaluate, type WalletPolicy } from "../src/policy/engine.js";
import type { ForgePayEvent } from "../src/events.js";

const policy: WalletPolicy = {
  allowedChains: ["mock"],
  assets: { USDC: { perTx: 50n, per24h: 100n, approvalAbove: 20n } },
  denyList: ["bad"],
};

let events: ForgePayEvent[];
let chain: MockChain;
let signer: DevSigner;
let wallet: WalletService;
let sanctioned: Set<string>;

beforeEach(async () => {
  events = [];
  sanctioned = new Set();
  chain = new MockChain();
  signer = new DevSigner();
  wallet = new WalletService({
    agentId: "a1",
    signer,
    chain,
    policies: { w: policy },
    sanctions: async (addr) => (sanctioned.has(addr) ? "hit" : "clear"),
    sink: (e) => void events.push(e),
  });
  chain.credit(await signer.address("mock"), "USDC", 1000n);
});

const req = (amount: bigint, to = "bob") => ({ walletId: "w", chain: "mock" as const, asset: "USDC", to, amount });

describe("policy", () => {
  const ledger = { spentSince: () => 0n };
  const clear = async () => "clear" as const;

  it("denies when wallet has no policy (fails closed)", async () => {
    expect((await evaluate(req(1n), undefined, ledger, clear)).decision).toBe("deny");
  });
  it("denies unknown asset, chain, deny-listed and sanctioned recipients", async () => {
    expect((await evaluate({ ...req(1n), asset: "ETH" }, policy, ledger, clear)).reasons).toEqual(["asset_not_allowed:ETH"]);
    expect((await evaluate({ ...req(1n), chain: "base" }, policy, ledger, clear)).decision).toBe("deny");
    expect((await evaluate(req(1n, "BAD"), policy, ledger, clear)).reasons).toEqual(["recipient_on_deny_list"]);
    expect((await evaluate(req(1n), policy, ledger, async () => "hit")).reasons).toEqual(["sanctions_hit"]);
  });
  it("denies if the sanctions check throws", async () => {
    const r = await evaluate(req(1n), policy, ledger, async () => { throw new Error("list stale"); });
    expect(r.decision).toBe("deny");
  });
  it("applies per-tx, 24h and approval thresholds", async () => {
    expect((await evaluate(req(51n), policy, ledger, clear)).reasons).toEqual(["exceeds_per_tx_limit"]);
    expect((await evaluate(req(30n), policy, { spentSince: () => 80n }, clear)).reasons).toEqual(["exceeds_24h_limit"]);
    expect((await evaluate(req(21n), policy, ledger, clear)).decision).toBe("require_approval");
    expect((await evaluate(req(20n), policy, ledger, clear)).decision).toBe("allow");
  });
});

describe("wallet flow", () => {
  it("previews, executes once, moves funds and emits events", async () => {
    const p = await wallet.sendPreview(req(10n));
    expect(p.policy.decision).toBe("allow");
    const { txHash } = await wallet.sendExecute(p.id);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(chain.balance("bob", "USDC")).toBe(10n);
    await expect(wallet.sendExecute(p.id)).rejects.toThrow("preview_already_used");
    expect(events.map((e) => e.type)).toEqual(["agent_wallet.transfer.previewed", "agent_wallet.transfer.executed"]);
  });

  it("requires human approval above threshold", async () => {
    const p = await wallet.sendPreview(req(30n));
    expect(p.policy.decision).toBe("require_approval");
    await expect(wallet.sendExecute(p.id)).rejects.toThrow("approval_required");

    const p2 = await wallet.sendPreview(req(30n));
    wallet.decideApproval(p2.approvalId!, true);
    await expect(wallet.sendExecute(p2.id)).resolves.toHaveProperty("txHash");
  });

  it("re-checks policy at execute time", async () => {
    const p = await wallet.sendPreview(req(10n, "carol"));
    sanctioned.add("carol"); // carol becomes sanctioned after the preview
    await expect(wallet.sendExecute(p.id)).rejects.toThrow("denied:sanctions_hit");
    expect(chain.balance("carol", "USDC")).toBe(0n);
  });

  it("enforces the rolling 24h limit across executions", async () => {
    for (let i = 0; i < 5; i++) await wallet.sendExecute((await wallet.sendPreview(req(20n))).id);
    const p = await wallet.sendPreview(req(1n));
    expect(p.policy.reasons).toEqual(["exceeds_24h_limit"]);
  });

  it("dev signer refuses mainnet and never serialises its key", async () => {
    await expect(signer.address("base")).rejects.toThrow("refuses non-testnet");
    expect(JSON.stringify(signer)).toBe('{"id":"dev"}');
  });
});
