import type { AfpLedger } from "@acard/core";
import type { AfpLedgerPort } from "./types.js";

/** Wraps the synchronous `AfpLedger` behind the async port — every call just awaits an immediate value. */
export class InMemoryAfpLedger implements AfpLedgerPort {
  constructor(private readonly ledger: AfpLedger) {}

  async recordIntent(...args: Parameters<AfpLedger["recordIntent"]>) {
    return this.ledger.recordIntent(...args);
  }
  async getIntent(...args: Parameters<AfpLedger["getIntent"]>) {
    return this.ledger.getIntent(...args);
  }
  async beginExecution(...args: Parameters<AfpLedger["beginExecution"]>) {
    return this.ledger.beginExecution(...args);
  }
  async completeExecution(...args: Parameters<AfpLedger["completeExecution"]>) {
    return this.ledger.completeExecution(...args);
  }
  async markReconciling(...args: Parameters<AfpLedger["markReconciling"]>) {
    return this.ledger.markReconciling(...args);
  }
  async markFailed(...args: Parameters<AfpLedger["markFailed"]>) {
    return this.ledger.markFailed(...args);
  }
  async settle(...args: Parameters<AfpLedger["settle"]>) {
    return this.ledger.settle(...args);
  }
  async reverse(...args: Parameters<AfpLedger["reverse"]>) {
    return this.ledger.reverse(...args);
  }
  async get(...args: Parameters<AfpLedger["get"]>) {
    return this.ledger.get(...args);
  }
  async getByIdempotencyKey(...args: Parameters<AfpLedger["getByIdempotencyKey"]>) {
    return this.ledger.getByIdempotencyKey(...args);
  }
  async list(...args: Parameters<AfpLedger["list"]>) {
    return this.ledger.list(...args);
  }
  async dueForSettlement(...args: Parameters<AfpLedger["dueForSettlement"]>) {
    return this.ledger.dueForSettlement(...args);
  }
}
