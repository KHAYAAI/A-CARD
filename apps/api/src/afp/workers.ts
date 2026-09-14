import type { AfpTransaction } from "@acard/core";
import type { AfpLedgerPort } from "./types.js";
import type { RailAdapter } from "../rails/types.js";

/**
 * The machinery that moves AFP transactions through their own state model
 * over time.
 *
 * The ledger's states were complete and tested from the day it shipped;
 * nothing drove them. `dueForSettlement()` existed and had a caller in no
 * production path, so a `posted` transaction sat there forever, and
 * `reconciling` — the state that exists precisely for the frightening case
 * where money may or may not have moved — had no exit but direct database
 * access.
 *
 * A rail that can start a payment it cannot finish is worse than one that is
 * switched off, so these run whenever AFP does.
 *
 * Two deliberate properties:
 *
 *   - **Settlement is a clock, not a network call.** `settle()` closes a
 *     transaction whose own finality window has elapsed. It asks nobody:
 *     the window passing IS the event. That makes this tick cheap and safe
 *     to run often.
 *
 *   - **Reconciliation asks the rail and believes the answer, or leaves it
 *     alone.** An ambiguous outcome is resolved by going back to the rail
 *     that produced it. If the rail cannot say, the transaction stays
 *     `reconciling` — the one thing that must never happen is guessing, in
 *     either direction, because guessing "failed" double-pays on retry and
 *     guessing "settled" believes money moved when it may not have.
 */

export interface AfpWorkerDeps {
  ledger: AfpLedgerPort;
  rails: RailAdapter[];
  /** Injected for tests. Defaults to the real clock. */
  now?: () => number;
}

export interface SettlementSweepResult {
  examined: number;
  settled: string[];
  failed: Array<{ transactionId: string; error: string }>;
}

/**
 * Close every transaction whose settlement clock has run out.
 *
 * Errors are collected per transaction rather than thrown: one stuck record
 * must not stop the sweep from settling the rest, and a scheduled job that
 * dies on its first bad row silently stops doing its job.
 */
export async function runSettlementSweep(deps: AfpWorkerDeps): Promise<SettlementSweepResult> {
  const now = (deps.now ?? Date.now)();
  const due = await deps.ledger.dueForSettlement(now);
  const result: SettlementSweepResult = { examined: due.length, settled: [], failed: [] };

  for (const tx of due) {
    try {
      await deps.ledger.settle(tx.id);
      result.settled.push(tx.id);
    } catch (error) {
      result.failed.push({ transactionId: tx.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export type ReconcileOutcome = "settled" | "failed" | "still_unknown" | "no_rail";

export interface ReconcileResult {
  transactionId: string;
  outcome: ReconcileOutcome;
  detail: string;
}

/**
 * How a rail answers "did this actually happen?".
 *
 * Optional on `RailAdapter` on purpose: a rail that cannot answer is a rail
 * whose ambiguous transactions must stay parked for a human, and pretending
 * otherwise by defaulting to an answer is the exact failure this state
 * exists to prevent.
 */
export interface ReconcilableRail extends RailAdapter {
  /**
   * Returns whether the transaction really happened, or `undefined` when the
   * rail genuinely cannot tell yet. `undefined` is a valid, expected answer —
   * not an error.
   */
  confirm?(transaction: AfpTransaction): Promise<{ happened: boolean; reference?: string } | undefined>;
}

/**
 * Resolve one ambiguous transaction by asking the rail that produced it.
 *
 * Never guesses. The transaction leaves `reconciling` only on a definite
 * answer; anything else leaves it exactly where it is, for a human.
 */
export async function reconcileTransaction(
  deps: AfpWorkerDeps,
  transactionId: string,
): Promise<ReconcileResult> {
  const tx = await deps.ledger.get(transactionId);
  if (tx.status !== "reconciling") {
    return { transactionId, outcome: "still_unknown", detail: `transaction is ${tx.status}, not reconciling` };
  }

  const rail = deps.rails.find((r) => r.profile.id === tx.rail) as ReconcilableRail | undefined;
  if (!rail) {
    return { transactionId, outcome: "no_rail", detail: `rail ${tx.rail} is not configured on this instance` };
  }
  if (!rail.confirm) {
    return {
      transactionId,
      outcome: "still_unknown",
      detail: `rail ${tx.rail} cannot confirm outcomes — this needs a human`,
    };
  }

  let answer: { happened: boolean; reference?: string } | undefined;
  try {
    answer = await rail.confirm(tx);
  } catch (error) {
    // The rail being unreachable tells us nothing about the money. Leave it.
    return {
      transactionId,
      outcome: "still_unknown",
      detail: `rail ${tx.rail} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (answer === undefined) {
    return { transactionId, outcome: "still_unknown", detail: `rail ${tx.rail} cannot tell yet` };
  }

  if (answer.happened) {
    await deps.ledger.completeExecution(tx.id, {
      railReference: answer.reference ?? tx.railReference ?? `reconciled_${tx.id}`,
      immediate: tx.finality.kind === "instant",
    });
    return { transactionId, outcome: "settled", detail: "rail confirmed the payment happened" };
  }

  await deps.ledger.markFailed(tx.id, "reconciliation: the rail confirmed this never happened");
  return { transactionId, outcome: "failed", detail: "rail confirmed the payment never happened" };
}

/**
 * A single scheduled tick: settle what is due, then try to resolve anything
 * parked as ambiguous.
 *
 * Returns what it did rather than logging and swallowing, so the caller (a
 * cron, a route, a test) decides what to do with the result.
 */
export async function runAfpTick(deps: AfpWorkerDeps): Promise<{
  settlement: SettlementSweepResult;
  reconciliation: ReconcileResult[];
}> {
  const settlement = await runSettlementSweep(deps);
  const parked = await deps.ledger.listReconciling();
  const reconciliation: ReconcileResult[] = [];
  for (const tx of parked) {
    reconciliation.push(await reconcileTransaction(deps, tx.id));
  }
  return { settlement, reconciliation };
}

/**
 * Drive `runAfpTick` on an interval. Returns a stop function.
 *
 * `unref()` keeps the timer from holding the process open — a background
 * sweep must never be the reason a container refuses to shut down.
 */
export function startAfpWorkers(deps: AfpWorkerDeps, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(async () => {
    // Skip rather than overlap: a slow tick must not stack on itself.
    if (running) return;
    running = true;
    try {
      const result = await runAfpTick(deps);
      const stuck = result.reconciliation.filter((r) => r.outcome === "still_unknown" || r.outcome === "no_rail");
      if (result.settlement.settled.length > 0 || stuck.length > 0) {
        console.log(
          `AFP workers: settled ${result.settlement.settled.length}, still unresolved ${stuck.length}` +
            (stuck.length > 0 ? ` — ${stuck.map((s) => s.transactionId).join(", ")}` : ""),
        );
      }
      for (const failure of result.settlement.failed) {
        console.error(`AFP workers: could not settle ${failure.transactionId}: ${failure.error}`);
      }
    } catch (error) {
      console.error("AFP workers: tick failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
