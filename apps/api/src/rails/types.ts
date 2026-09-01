import type { AfpIntent, RailExecutionResult, RailProfile, RailQuote } from "@acard/core";

/**
 * Thrown by a rail adapter's `execute` when the outcome is genuinely
 * unknown — the request may or may not have reached the counterparty, so
 * neither "it worked" nor "it failed" is a safe guess. The route handler
 * that calls `execute` treats this specifically as `AfpLedger.markReconciling`
 * rather than `markFailed`; every other thrown error (a definite decline, a
 * definite 4xx from a counterparty that clearly received and rejected the
 * request) is a real "no", not an unknown, and gets `markFailed`.
 */
export class RailAmbiguousOutcomeError extends Error {}

/**
 * The one interface every rail implements. `packages/core/src/afp.ts`'s
 * routing engine and ledger only ever see the shapes this file exports —
 * they never import a specific rail, which is what lets `routeIntent` stay
 * a pure function over `RailQuote[]` regardless of how many rails exist or
 * what any one of them needs to do over the network to answer.
 */
export interface RailAdapter {
  readonly profile: RailProfile;
  /**
   * A quote should never have a side effect a repeated call would compound —
   * calling it twice must be as safe as calling it once. Real network
   * quoting (a live FX rate, a card network's current interchange estimate)
   * is fine; a probe that itself moves money or provisions anything is not.
   */
  quote(intent: AfpIntent): Promise<RailQuote>;
  /** Actually moves the money (or, for x402, actually pays for the resource). Not expected to be idempotent on its own — the ledger's idempotency key is what makes the whole execute path safe to retry. */
  execute(intent: AfpIntent): Promise<RailExecutionResult>;
}
