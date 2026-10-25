import { Http, type HttpOptions } from "./http.js";
import type { Availability, CatalogItem, Currency, Order, OrderStatus, RequestOptions } from "./types.js";

export interface AcardMerchantOptions extends Omit<HttpOptions, "token" | "baseUrl"> {
  /** A merchant machine key, `mk_live_…`, minted by the shop owner via POST /v1/merchant-portal/api-keys. */
  apiKey: string;
  baseUrl?: string;
}

export interface CatalogSyncItem {
  /** Your own SKU. The merchant API never needs A-CARD's internal item ids. */
  sku: string;
  name: string;
  description?: string;
  unit?: string;
  unit_price_cents: number;
  currency?: Currency;
  availability?: Availability;
  quantity_available?: number;
  lead_time_days?: number;
}

/**
 * Client for a merchant's own POS or ERP integration. A merchant key is
 * scoped to exactly one merchant and can never reach a wallet or card.
 *
 * ```ts
 * const shop = new AcardMerchant({ apiKey: process.env.ACARD_MERCHANT_KEY! });
 * await shop.catalog.sync([{ sku: "CEM-425-50", name: "Cement 42.5N 50kg", unit: "bag", unit_price_cents: 11_500 }]);
 * ```
 */
export class AcardMerchant {
  private readonly http: Http;
  readonly catalog: MerchantCatalog;
  readonly orders: MerchantOrders;
  readonly webhook: MerchantWebhookResource;

  constructor(options: AcardMerchantOptions) {
    if (!options?.apiKey) throw new Error("AcardMerchant: apiKey is required");
    this.http = new Http({ ...options, baseUrl: options.baseUrl ?? "http://localhost:8787", token: options.apiKey });
    this.catalog = new MerchantCatalog(this.http);
    this.orders = new MerchantOrders(this.http);
    this.webhook = new MerchantWebhookResource(this.http);
  }

  /** Who this key belongs to, catalogue health, and pending sales. */
  async me(): Promise<Record<string, unknown>> {
    return this.http.request("GET", "/v1/merchant-api/me");
  }

  async reliability(): Promise<unknown> {
    return (await this.http.request<{ reliability: unknown }>("GET", "/v1/merchant-api/reliability")).reliability;
  }
}

class MerchantCatalog {
  constructor(private readonly http: Http) {}

  async list(): Promise<CatalogItem[]> {
    return (await this.http.request<{ items: CatalogItem[] }>("GET", "/v1/merchant-api/catalog")).items;
  }

  /**
   * Bulk upsert by your SKU (up to 500 per call). One bad row never discards
   * the others: the API answers 207 with a per-SKU breakdown.
   */
  async sync(items: CatalogSyncItem[], options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return this.http.request("PUT", "/v1/merchant-api/catalog", { body: { items }, ...options });
  }

  /** Stock-only restate by SKU — the highest-value call: it keeps your offers fresh. */
  async restate(
    items: Array<{ sku: string; availability: Availability; quantity_available?: number }>,
    options: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.http.request("POST", "/v1/merchant-api/stock", { body: { items }, ...options });
  }
}

class MerchantOrders {
  constructor(private readonly http: Http) {}

  async list(filter: { status?: OrderStatus } = {}): Promise<Order[]> {
    return (await this.http.request<{ orders: Order[] }>("GET", "/v1/merchant-api/orders", { query: { status: filter.status } })).orders;
  }

  /** Move an order forward. Illegal transitions are refused with `invalid_state`. */
  async advance(
    id: string,
    input: { status: Exclude<OrderStatus, "placed" | "cancelled">; note?: string; promised_at?: string; tracking_reference?: string },
    options: RequestOptions = {},
  ): Promise<Order> {
    return (await this.http.request<{ order: Order }>("POST", `/v1/merchant-api/orders/${encodeURIComponent(id)}/advance`, { body: input, ...options }))
      .order;
  }

  /** Resend `order.placed` for an order your endpoint missed. */
  async redeliver(id: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return this.http.request("POST", `/v1/merchant-api/orders/${encodeURIComponent(id)}/redeliver`, options);
  }
}

class MerchantWebhookResource {
  constructor(private readonly http: Http) {}

  /**
   * Register where orders are pushed. The returned `secret` is shown once —
   * verify deliveries with `verifyMerchantWebhook(rawBody, header, secret)`.
   */
  async set(url: string, events?: string[]): Promise<{ webhook: Record<string, unknown>; secret: string }> {
    return this.http.request("PUT", "/v1/merchant-api/webhook", { body: { url, events } });
  }

  async clear(): Promise<void> {
    await this.http.request("DELETE", "/v1/merchant-api/webhook");
  }
}
