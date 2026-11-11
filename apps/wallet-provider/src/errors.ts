/** An error with an HTTP status and a stable machine-readable code. Messages never contain key material. */
export class ProviderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
