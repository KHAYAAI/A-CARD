/**
 * End-to-end check against a REAL test network (Base Sepolia by default).
 * Test USDC only; it has no value.
 *
 *   1. Start the provider with Base Sepolia (see README "Real test network").
 *   2. PROVIDER_URL=http://localhost:8788 PROVIDER_API_KEY=... npx tsx scripts/testnet-smoke.ts
 *   3. When it prints an address, send it test USDC from https://faucet.circle.com (Base Sepolia)
 *      and a little test ETH for gas from a Base Sepolia faucet.
 * It then waits for the funds, sends 0.01 USDC to SMOKE_TO (default: a burn address),
 * and prints the explorer link. Run it twice: the second run must be a replay, not a second send.
 */
const url = (process.env.PROVIDER_URL ?? "http://localhost:8788").replace(/\/$/, "");
const key = process.env.PROVIDER_API_KEY ?? (console.error("PROVIDER_API_KEY is required"), process.exit(1));
const chain = process.env.SMOKE_CHAIN ?? "ethereum";
const to = process.env.SMOKE_TO ?? "0x000000000000000000000000000000000000dEaD";
const explorer = process.env.SMOKE_EXPLORER ?? "https://sepolia.basescan.org/tx/";
const h = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const call = async (path: string, body?: unknown) => {
  const r = await fetch(url + path, { method: body ? "POST" : "GET", headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j as any;
};

const status = await call("/status");
if (!status.testnet) throw new Error("refusing: this provider is not on test networks");
console.log("networks:", status.networks.map((n: any) => `${n.chain}=${n.network}${n.rpc ? "" : " (no RPC!)"}`).join(", "));
const w = await call("/wallets", { userId: "smoke-test", chain });
console.log(`\nwallet: ${w.address}\nfund it with test USDC + test gas, then wait...\n`);
for (;;) {
  const b = await call(`/wallets/balance?chain=${chain}&address=${w.address}`).catch((e) => ({ error: String(e) }));
  if (b.error) console.log(b.error);
  else if (BigInt(b.raw ?? 0) >= 10_000n) break;
  else console.log("balance:", JSON.stringify(b));
  await new Promise((r) => setTimeout(r, 15_000));
}
const t = await call("/wallets/transfer", { chain, from: w.address, to, amount: "10000", idempotencyKey: `smoke-${w.address}` });
console.log(`${t.replayed ? "REPLAYED (no second send)" : "SENT"}: ${explorer}${t.txHash} confirmed=${t.confirmed}`);
