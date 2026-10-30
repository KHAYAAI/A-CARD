import { newId, type AfpIntent, type RailExecutionResult, type RailProfile } from "@acard/core";
import { assertFetchableUrl, UnsafeUrlError } from "../x402/guard.js";
import {
  ATOMIC_PER_CENT,
  atomicToUsd,
  chooseRequirement,
  paymentHeader,
  readPaymentRequired,
  readSettlement,
  type PaymentRequirement,
} from "../x402/protocol.js";
import { newNonce, SANDBOX_SIGNER, type X402Signer } from "../x402/signer.js";
import { RailAmbiguousOutcomeError, type RailAdapter } from "./types.js";

/**
 * x402 as an AFP rail: the generic `POST /v1/afp/intents/:id/execute` path,
 * for an intent whose counterparty is a URL that charges over x402.
 *
 * The wire format (v1 and v2), the EIP-3009 signer and the URL guard live in
 * `apps/api/src/x402/`, shared with the card-governed payer behind
 * `POST /v1/afp/x402/pay` — which is the path agents should use, since it
 * also runs the payment through a card's limits and approvals. This rail
 * enforces the intent itself: the server's price must fit inside the
 * intent's amount (USD, in cents), or nothing is signed.
 */

export const X402_PROFILE: RailProfile = {
  id: "x402",
  label: "x402 machine payment",
  finality: { kind: "instant" },
};

export { SANDBOX_SIGNER, type X402Signer };
export type X402PaymentRequirement = PaymentRequirement;

export interface X402RailConfig {
  /** The address paying — must match whatever `signer` actually controls. */
  payerAddress: string;
  signer: X402Signer;
  /** CAIP-2 networks to pay on. Defaults to Base Sepolia only. */
  networks?: string[];
  /** Sandbox/tests only: allow plain-HTTP and private-network URLs. */
  allowPrivateNetworks?: boolean;
  /** Injectable for tests; defaults to the real global fetch. */
  fetchImpl?: typeof fetch;
}

export function createX402Rail(config: X402RailConfig): RailAdapter {
  const doFetch = config.fetchImpl ?? fetch;
  const networks = config.networks ?? ["eip155:84532"];

  return {
    profile: X402_PROFILE,
    carriesRealValue: config.signer.isSandbox !== true,

    async quote(intent) {
      // No live preflight: probing the URL would itself be a request against
      // someone else's server. The real price is only known once execute()
      // receives the 402 — and is held to the intent's amount there.
      if (!intent.counterparty.startsWith("http")) {
        return { rail: "x402", available: false, costCents: 0, etaSeconds: 0, reason: "counterparty is not an HTTP(S) resource" };
      }
      if (intent.currency !== "USD") {
        return { rail: "x402", available: false, costCents: 0, etaSeconds: 0, reason: "x402 settles in USDC; the intent must be in USD" };
      }
      return { rail: "x402", available: true, costCents: 0, etaSeconds: 1 };
    },

    async execute(intent: AfpIntent): Promise<RailExecutionResult> {
      let url: URL;
      try {
        url = await assertFetchableUrl(intent.counterparty, { allowPrivateNetworks: config.allowPrivateNetworks });
      } catch (error) {
        throw new Error(`x402: ${error instanceof UnsafeUrlError ? error.message : String(error)}`);
      }
      const safeFetch = async (headers?: Record<string, string>) => {
        try {
          return await doFetch(url, { redirect: "manual", headers });
        } catch (error) {
          // The request may or may not have reached the counterparty — this
          // adapter cannot tell which, so it does not guess.
          throw new RailAmbiguousOutcomeError(
            `x402: network failure calling ${url} — outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const first = await safeFetch();
      if (first.ok) {
        // Free, or already paid for out of band — still a real, successful execution.
        return { railReference: newId("x402free"), immediate: true };
      }
      if (first.status !== 402) throw new Error(`x402: unexpected status ${first.status} requesting ${url}`);

      const required = await readPaymentRequired(first);
      if (!required) throw new Error(`x402: ${url} answered 402 without an x402 payment description`);
      const requirement = chooseRequirement(required, networks);
      if (!requirement) throw new Error(`x402: no USDC "exact" payment option on ${networks.join(", ")} for ${url}`);

      const cap = BigInt(intent.amount) * ATOMIC_PER_CENT;
      if (BigInt(requirement.amount) > cap) {
        throw new Error(`x402: ${url} asks ${atomicToUsd(BigInt(requirement.amount))} USD, above this intent's ${atomicToUsd(cap)} USD`);
      }

      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from: config.payerAddress,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: String(now - 60),
        validBefore: String(now + Math.max(30, requirement.maxTimeoutSeconds)),
        nonce: newNonce(),
      };
      const { signature } = await config.signer.sign({ requirement, ...authorization });
      const header = paymentHeader(required, requirement, authorization, signature);

      const retry = await safeFetch({ [header.name]: header.value });
      const settlement = readSettlement(retry);
      if (!retry.ok) {
        if (retry.status >= 500 || settlement?.transaction) {
          throw new RailAmbiguousOutcomeError(`x402: ${url} answered ${retry.status} after a signed payment — outcome unknown`);
        }
        throw new Error(`x402: payment retry rejected with status ${retry.status} for ${url}`);
      }
      return { railReference: settlement?.transaction || newId("x402tx"), immediate: true };
    },
  };
}
