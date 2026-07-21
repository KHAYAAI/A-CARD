/**
 * Thin HTTP client for the A-CARD API, used by the MCP server and CLI. Keeps
 * the MCP layer a pure protocol adapter: all business logic lives behind the
 * REST API, exactly as it would in production.
 */

export interface AcardClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class AcardApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class AcardClient {
  constructor(private readonly options: AcardClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) {
      throw new AcardApiError(
        response.status,
        body?.error?.code ?? "unknown",
        body?.error?.message ?? `request failed with ${response.status}`,
      );
    }
    return body as T;
  }

  wallet(currency?: string) {
    const qs = currency ? `?currency=${encodeURIComponent(currency)}` : "";
    return this.request<{
      wallet: { available: number; posted: number; held: number; currency: string };
      wallets: Array<{ available: number; posted: number; held: number; currency: string }>;
    }>(`/v1/wallet${qs}`);
  }

  fundWallet(amount: number, currency?: string) {
    return this.request("/v1/wallet/fund", { method: "POST", body: JSON.stringify({ amount, currency }) });
  }

  createCard(input: Record<string, unknown>, idempotencyKey?: string) {
    return this.request<{ card: any }>("/v1/cards", {
      method: "POST",
      body: JSON.stringify(input),
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    });
  }

  getCard(id: string) {
    return this.request<{ card: any }>(`/v1/cards/${id}`);
  }

  listCards() {
    return this.request<{ cards: any[] }>("/v1/cards");
  }

  closeCard(id: string) {
    return this.request<{ card: any }>(`/v1/cards/${id}/close`, { method: "POST" });
  }

  listTransactions(cardId?: string) {
    const qs = cardId ? `?card_id=${encodeURIComponent(cardId)}` : "";
    return this.request<{ transactions: any[] }>(`/v1/transactions${qs}`);
  }

  listApprovals(status?: string) {
    const qs = status ? `?status=${status}` : "";
    return this.request<{ approvals: any[] }>(`/v1/approvals${qs}`);
  }

  decideApproval(id: string, decision: "approve" | "deny") {
    return this.request<{ approval: any }>(`/v1/approvals/${id}/${decision}`, { method: "POST" });
  }

  simulatePurchase(input: Record<string, unknown>) {
    return this.request<{
      authorization_id: string;
      approved: boolean;
      decline_reason?: string;
      approval_id?: string;
      wallet: { available: number; currency: string };
    }>("/v1/simulate/purchase", { method: "POST", body: JSON.stringify(input) });
  }
}
