import { createHash, randomBytes } from "node:crypto";
import type { AfpIntent, RailExecutionResult, RailProfile } from "@acard/core";
import { RailAmbiguousOutcomeError, type RailAdapter } from "./types.js";

/**
 * The stablecoin rail — real interface, sandboxed implementation only. This
 * is the honest state of it: unlike x402 (self-describing per request) or
 * card (A-CARD's own existing rail), a real stablecoin transfer needs an
 * actual signer holding actual funds, which means a real custody decision —
 * a self-hosted signer, or a provider like Circle or Fireblocks. That
 * decision is out of scope here, exactly the same way a contracted card
 * issuer is out of scope for A-CARD itself: this ships the shape the real
 * client will fill in, not a pretend implementation of one.
 *
 * Finality: `instant`. Once a `StablecoinRailClient` reports a transfer
 * confirmed, it is not coming back — there is no reversal window on-chain,
 * which is exactly why `AfpLedger.reverse()` refuses to touch a transaction
 * on this rail.
 */

export const STABLECOIN_PROFILE: RailProfile = {
  id: "stablecoin",
  label: "Stablecoin transfer",
  finality: { kind: "instant" },
};

export interface StablecoinTransferResult {
  txHash: string;
  confirmed: boolean;
}

/**
 * The narrow surface a real client (chain RPC + signer, or a custody
 * provider's API) will implement. `apps/api` never talks to a chain
 * directly outside this interface, same reasoning as `EmbeddedWalletClient`
 * for linked crypto wallets elsewhere in this codebase.
 */
export interface StablecoinRailClient {
  transfer(input: { fromAddress: string; toAddress: string; amountMinorUnits: number; currency: string }): Promise<StablecoinTransferResult>;
}

/**
 * Deterministic, in-memory, instant "confirmation" — good enough to prove
 * the routing engine and the ledger's `instant`-finality path end to end,
 * and nothing more. Never wire this into a deployment that is meant to move
 * real value; it moves none.
 */
export function createSandboxStablecoinClient(): StablecoinRailClient {
  return {
    async transfer(input) {
      const txHash = `0x${createHash("sha256")
        .update(`${input.fromAddress}:${input.toAddress}:${input.amountMinorUnits}:${randomBytes(8).toString("hex")}`)
        .digest("hex")}`;
      return { txHash, confirmed: true };
    },
  };
}

export interface StablecoinRailConfig {
  client: StablecoinRailClient;
  fromAddress: string;
  /** Resolves the recipient's address for a given intent's counterparty. Kept separate from the client so the "which address does this merchant/API actually get paid at" question doesn't leak into the transfer mechanics. */
  resolveRecipient(intent: AfpIntent): string;
}

export function createStablecoinRail(config: StablecoinRailConfig): RailAdapter {
  return {
    profile: STABLECOIN_PROFILE,

    async quote(intent) {
      // On-chain gas is real but rail-side, not payer-side, for the
      // stablecoin schemes this is scoped to (a relayer or the platform's
      // own signer covers it) — modeled as free from AFP's routing
      // perspective, same as the card rail's network-side interchange.
      return { rail: "stablecoin", available: true, costCents: 0, etaSeconds: 3 };
    },

    async execute(intent): Promise<RailExecutionResult> {
      const toAddress = config.resolveRecipient(intent);
      let result;
      try {
        result = await config.client.transfer({
          fromAddress: config.fromAddress,
          toAddress,
          amountMinorUnits: intent.amount,
          currency: intent.currency,
        });
      } catch (error) {
        // A broadcast that never got a confirmed response (RPC timeout,
        // dropped connection) may still land on-chain later — genuinely
        // unknown until a status check against the chain resolves it.
        throw new RailAmbiguousOutcomeError(
          `stablecoin: transfer outcome unknown — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!result.confirmed) {
        throw new Error(`stablecoin transfer ${result.txHash} did not confirm`);
      }
      return { railReference: result.txHash, immediate: true };
    },
  };
}
