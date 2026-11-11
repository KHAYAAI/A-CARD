import type { AfpIntent, Chain, RailExecutionResult } from "@acard/core";
import { RailAmbiguousOutcomeError, type RailAdapter } from "./types.js";
import { STABLECOIN_PROFILE } from "./stablecoin.js";

/**
 * A stablecoin rail backed by a self-hosted embedded-wallet provider
 * (apps/wallet-provider). The sender is the account holder's own embedded
 * Ethereum wallet, the provider signs, and the intent id is the provider's
 * idempotency key so a retried execute can never pay twice.
 *
 * Whether this rail "carries real value" is read from the provider at
 * startup, not configured here: a provider pointed at test networks reports
 * testnet=true and the crypto compliance gate stays off; one pointed at
 * mainnet flips it on without anyone remembering a second switch.
 */
export interface ProviderStablecoinConfig {
  baseUrl: string;
  apiKey: string;
  /** The holder's linked wallets (core's `listLinkedWallets`). */
  listLinkedWallets(accountHolderId: string): Promise<{ kind: string; chain: string; address: string }[]>;
  chain?: Chain;
  fetchImpl?: typeof fetch;
}

const CENTS_TO_USDC_UNITS = 10_000n; // 1 USD cent = 0.01 USDC = 10,000 base units (6 decimals)

export async function createProviderStablecoinRail(config: ProviderStablecoinConfig): Promise<RailAdapter> {
  const f = config.fetchImpl ?? fetch;
  const chain = config.chain ?? "ethereum";
  const headers = { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
  const base = config.baseUrl.replace(/\/$/, "");

  const statusRes = await f(`${base}/status`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!statusRes.ok) throw new Error(`wallet provider status check failed: ${statusRes.status}`);
  const status = (await statusRes.json()) as { testnet: boolean; networks: { chain: string; network: string; testnet: boolean; transfers: boolean }[] };
  const net = status.networks.find((n) => n.chain === chain);
  if (!net?.transfers) throw new Error(`wallet provider cannot send transfers on ${chain}`);

  const sender = async (holderId: string) => (await config.listLinkedWallets(holderId)).find((w) => w.kind === "embedded" && w.chain === chain);

  return {
    profile: STABLECOIN_PROFILE,
    carriesRealValue: !net.testnet,

    async quote(intent: AfpIntent) {
      const no = (reason: string) => ({ rail: "stablecoin" as const, available: false, costCents: 0, etaSeconds: 0, reason });
      if (intent.currency !== "USD") return no("the stablecoin rail settles in USDC; the intent must be in USD");
      const w = await sender(intent.accountHolderId);
      if (!w) return no(`no embedded ${chain} wallet`);
      let balance: bigint;
      try {
        const r = await f(`${base}/wallets/balance?chain=${chain}&address=${encodeURIComponent(w.address)}`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return no(`wallet provider could not read the balance (${r.status})`);
        balance = BigInt(((await r.json()) as { raw: string }).raw);
      } catch {
        return no("wallet provider is unreachable");
      }
      const need = BigInt(intent.amount) * CENTS_TO_USDC_UNITS;
      if (balance < need) return no(`the embedded wallet holds ${Number(balance) / 1e6} USDC`);
      return { rail: "stablecoin" as const, available: true, costCents: 0, etaSeconds: 5 };
    },

    async execute(intent: AfpIntent): Promise<RailExecutionResult> {
      if (intent.currency !== "USD") throw new Error("stablecoin: the intent must be in USD");
      if (!/^0x[0-9a-fA-F]{40}$/.test(intent.counterparty)) throw new Error("stablecoin: the counterparty must be an EVM address");
      const w = await sender(intent.accountHolderId);
      if (!w) throw new Error(`stablecoin: no embedded ${chain} wallet`);
      let res: Response;
      try {
        res = await f(`${base}/wallets/transfer`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chain, from: w.address, to: intent.counterparty, amount: (BigInt(intent.amount) * CENTS_TO_USDC_UNITS).toString(), idempotencyKey: `afp-${intent.id}` }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        // The request may have reached the provider and been broadcast: unknown, not failed.
        throw new RailAmbiguousOutcomeError(`stablecoin: transfer outcome unknown — ${(e as Error).message}`);
      }
      const body = (await res.json().catch(() => ({}))) as { txHash?: string; confirmed?: boolean; error?: { code?: string; message?: string } };
      if (res.status >= 500) throw new RailAmbiguousOutcomeError(`stablecoin: provider error ${res.status} — outcome unknown`);
      if (!res.ok) throw new Error(`stablecoin: ${body.error?.message ?? `provider refused (${res.status})`}`);
      if (!body.txHash) throw new RailAmbiguousOutcomeError("stablecoin: provider returned no transaction hash");
      // Broadcast but not yet confirmed: it may still land, so this is unknown rather than failed.
      if (!body.confirmed) throw new RailAmbiguousOutcomeError(`stablecoin: transfer ${body.txHash} broadcast, not yet confirmed`);
      return { railReference: body.txHash, immediate: true };
    },
  };
}
