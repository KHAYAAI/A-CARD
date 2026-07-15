export class DomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string) {
    super("not_found", `${what} ${id} not found`, 404);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(message = "insufficient available balance") {
    super("insufficient_funds", message, 402);
  }
}

export class InvalidStateError extends DomainError {
  constructor(message: string) {
    super("invalid_state", message, 409);
  }
}
