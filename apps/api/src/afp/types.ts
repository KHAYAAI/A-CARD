import type { AfpIntent, AfpTransaction, RailExecutionResult, RailFinality, RailId } from "@acard/core";

/**
 * The async port `/v1/afp/*` depends on — `AfpLedger`'s own method surface,
 * one `Promise` at a time, same pattern as `MerchantDirectoryPort` /
 * `MerchantAuthPort`. Two implementations:
 *
 *   - `InMemoryAfpLedger` (memory.ts) — wraps the synchronous `AfpLedger`
 *     for the sandbox and single-writer snapshot path.
 *   - `PostgresAfpLedger` (postgres.ts) — a real multi-writer store, so AFP
 *     can run on the same Postgres deployment A-CARD's own ledger does.
 */
export interface AfpLedgerPort {
  recordIntent(intent: AfpIntent): Promise<void>;
  getIntent(id: string): Promise<AfpIntent>;
  beginExecution(intent: AfpIntent, rail: RailId, finality: RailFinality, idempotencyKey: string): Promise<AfpTransaction>;
  completeExecution(transactionId: string, result: RailExecutionResult): Promise<AfpTransaction>;
  markReconciling(transactionId: string, note: string): Promise<AfpTransaction>;
  markFailed(transactionId: string, note: string): Promise<AfpTransaction>;
  settle(transactionId: string): Promise<AfpTransaction>;
  reverse(transactionId: string, reason: string): Promise<AfpTransaction>;
  get(id: string): Promise<AfpTransaction>;
  getByIdempotencyKey(key: string): Promise<AfpTransaction | undefined>;
  list(accountHolderId: string): Promise<AfpTransaction[]>;
  dueForSettlement(now?: number): Promise<AfpTransaction[]>;
}
