import { newId, type AfpIntent, type RailExecutionResult, type RailProfile, type RailQuote } from "@acard/core";
import { RailAmbiguousOutcomeError, type RailAdapter } from "./types.js";

/**
 * x402 — the one rail in AFP that genuinely needs no counterparty
 * relationship to build against, because it's self-describing per request:
 * ask for a resource, the server itself tells you what it costs and how to
 * pay, in the response. Wire shapes below follow the x402 v2 draft spec
 * (github.com/coinbase/x402, `specs/x402-specification-v2.md`, section
 * 5.1–5.4, checked September 2026) — verify against whichever facilitator
 * this actually settles through before it carries real payments, the same
 * caveat `sudo.ts` carries for the card issuer's wire format. The protocol
 * is still an active draft; field names have moved between spec revisions.
 *
 * What's real here: the full HTTP round trip — request, parse the 402,
 * pick an accepted payment option, retry with a signed payment header,
 * confirm the 200. What's explicitly NOT real: the cryptographic signature
 * over the actual transfer authorization, because producing one requires a
 * funded wallet and a private key this platform does not custody. That's
 * injected as an `X402Signer` — swap `SANDBOX_SIGNER` (which produces a
 * syntactically valid, cryptographically meaningless signature, purely so
 * the round trip is testable end to end) for a real one backed by whatever
 * this org's actual signing key turns out to be, once that decision is made.
 */

export const X402_PROFILE: RailProfile = {
  id: "x402",
  label: "x402 machine payment",
  finality: { kind: "instant" },
};

/** One option a 402 response offered — see spec §5.1.2. */
export interface X402PaymentRequirement {
  scheme: string; // "exact" is the only scheme the draft spec defines today
  network: string; // CAIP-2 chain id, e.g. "eip155:8453" (Base)
  amount: string; // decimal string, asset's own minor units
  asset: string; // token contract address
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface X402Required {
  x402Version: number;
  accepts: X402PaymentRequirement[];
  error?: string;
}

/** Produces the signed `authorization` object the "exact" EVM scheme's payload carries — the one piece that needs a real key. */
export interface X402Signer {
  sign(input: {
    requirement: X402PaymentRequirement;
    from: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  }): Promise<{ signature: string }>;
}

/** Round-trips the flow so it's genuinely testable — never wire this into a deployment that touches real money. */
export const SANDBOX_SIGNER: X402Signer = {
  async sign() {
    return { signature: `0xsandbox${Math.random().toString(16).slice(2)}` };
  },
};

function buildPaymentHeader(
  requirement: X402PaymentRequirement,
  from: string,
  authorization: { signature: string; value: string; validAfter: string; validBefore: string; nonce: string },
): string {
  const payload = {
    x402Version: 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature: authorization.signature,
      authorization: {
        from,
        to: requirement.payTo,
        value: authorization.value,
        validAfter: authorization.validAfter,
        validBefore: authorization.validBefore,
        nonce: authorization.nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export interface X402RailConfig {
  /** The address paying — needs to match whatever `signer` actually controls. */
  payerAddress: string;
  signer: X402Signer;
  /** Injectable for tests; defaults to the real global fetch. */
  fetchImpl?: typeof fetch;
}

export function createX402Rail(config: X402RailConfig): RailAdapter {
  const doFetch = config.fetchImpl ?? fetch;

  const pickRequirement = (required: X402Required, intent: AfpIntent): X402PaymentRequirement | undefined =>
    // "exact" is the only scheme this adapter can sign for today (the
    // EIP-3009 transferWithAuthorization shape above); a facilitator
    // offering a consumption-based or other scheme is skipped rather than
    // guessed at.
    required.accepts.find((r) => r.scheme === "exact");

  return {
    profile: X402_PROFILE,

    async quote(intent) {
      // No live preflight: probing the counterparty URL to "get a quote"
      // would itself be a request against someone else's server with
      // whatever side effects that server attaches to being asked — x402
      // resources are meant to be requested once, paid for, and done. So
      // this reports the rail's known characteristics rather than a
      // per-request negotiated price; the real cost is only known once
      // execute() actually receives the 402.
      if (!intent.counterparty.startsWith("http")) {
        return { rail: "x402", available: false, costCents: 0, etaSeconds: 0, reason: "counterparty is not an HTTP(S) resource" };
      }
      return { rail: "x402", available: true, costCents: 0, etaSeconds: 1 };
    },

    async execute(intent): Promise<RailExecutionResult> {
      const safeFetch = async (input: string, init?: RequestInit) => {
        try {
          return await doFetch(input, init);
        } catch (error) {
          // The request may or may not have reached the counterparty — a
          // DNS failure or a refused connection means it didn't, but a
          // dropped connection mid-response means it might have. Either way
          // this adapter cannot tell which, so it does not guess.
          throw new RailAmbiguousOutcomeError(
            `x402: network failure calling ${input} — outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };

      const first = await safeFetch(intent.counterparty);
      if (first.ok) {
        // The resource turned out to be free, or already paid for out of
        // band — still a real, successful execution.
        return { railReference: first.headers.get("x-payment-response") ?? newId("x402free"), immediate: true };
      }
      if (first.status !== 402) {
        throw new Error(`x402: unexpected status ${first.status} requesting ${intent.counterparty}`);
      }

      const required = (await first.json()) as X402Required;
      const requirement = pickRequirement(required, intent);
      if (!requirement) {
        throw new Error(`x402: no "exact"-scheme payment option offered for ${intent.counterparty}`);
      }

      const now = Math.floor(Date.now() / 1000);
      const validAfter = String(now - 60);
      const validBefore = String(now + requirement.maxTimeoutSeconds);
      const nonce = `0x${newId("x402n").replace(/[^a-f0-9]/gi, "").padEnd(64, "0").slice(0, 64)}`;
      const { signature } = await config.signer.sign({
        requirement,
        from: config.payerAddress,
        value: requirement.amount,
        validAfter,
        validBefore,
        nonce,
      });

      const paymentHeader = buildPaymentHeader(requirement, config.payerAddress, {
        signature,
        value: requirement.amount,
        validAfter,
        validBefore,
        nonce,
      });

      const retry = await safeFetch(intent.counterparty, { headers: { "X-PAYMENT": paymentHeader } });
      if (!retry.ok) {
        throw new Error(`x402: payment retry rejected with status ${retry.status} for ${intent.counterparty}`);
      }
      const settlement = retry.headers.get("x-payment-response");
      return { railReference: settlement ?? newId("x402tx"), immediate: true };
    },
  };
}
