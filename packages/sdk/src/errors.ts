/**
 * Every non-2xx response becomes an `AcardError`. Branch on `code` — it is
 * stable within /v1 — never on `message`. The full list is in
 * docs/reference/errors.md.
 *
 * A *decline* is not an error: a purchase the rules refused comes back as a
 * normal result with `approved: false` and a `decline_reason`.
 */
export class AcardError extends Error {
  override readonly name = "AcardError";

  constructor(
    /** HTTP status, or 0 when the request never got a response. */
    readonly status: number,
    /** Stable machine-readable code, e.g. `not_found`, `invalid_request`, `plan_limit_exceeded`. */
    readonly code: string,
    message: string,
    /** Validation issues, present on `invalid_request`. */
    readonly issues?: unknown[],
    /** The full response body, for fields beyond the error envelope (e.g. `verification_status`). */
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** True for failures worth retrying with the same idempotency key. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** Thrown by `waitForApproval` when nobody decides in time. */
export class ApprovalTimeoutError extends Error {
  override readonly name = "ApprovalTimeoutError";
  constructor(readonly approvalId: string) {
    super(`approval ${approvalId} was not decided in time`);
  }
}
