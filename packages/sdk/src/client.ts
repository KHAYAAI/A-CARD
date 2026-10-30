import { ApprovalTimeoutError } from "./errors.js";
import { Http, type HttpOptions } from "./http.js";
import type {
  AccountHolder,
  Approval,
  Card,
  CardTransaction,
  CreateCardInput,
  CreatedCard,
  Currency,
  CatalogItem,
  OfferSearchResult,
  Order,
  PlaceOrderInput,
  PublicMerchant,
  PurchaseResult,
  RequestOptions,
  SearchOffersInput,
  SignupInput,
  SignupResult,
  SimulatePurchaseInput,
  WalletBalance,
  X402PayInput,
  X402PayResult,
  X402Tab,
} from "./types.js";

export interface AcardOptions extends Omit<HttpOptions, "token" | "baseUrl"> {
  /** Tenant API key (`ak_…`) or a dashboard session token (`sess_…`). */
  apiKey: string;
  /** Defaults to the local sandbox, http://localhost:8787. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "http://localhost:8787";

/**
 * The A-CARD API client for an organization (the buyer side): wallets, cards,
 * approvals, the sandbox purchase simulator, and A-MERCHANT discovery and
 * ordering.
 *
 * ```ts
 * const acard = new Acard({ apiKey: process.env.ACARD_API_KEY! });
 * const card = await acard.cards.create({ label: "fuel", limits: { per_transaction: 500_000 } });
 * ```
 */
export class Acard {
  private readonly http: Http;

  readonly wallet: WalletResource;
  readonly cards: CardsResource;
  readonly transactions: TransactionsResource;
  readonly approvals: ApprovalsResource;
  readonly sandbox: SandboxResource;
  readonly merchants: MerchantsResource;
  readonly orders: OrdersResource;
  readonly x402: X402Resource;

  constructor(options: AcardOptions) {
    if (!options?.apiKey) throw new Error("Acard: apiKey is required");
    this.http = new Http({ ...options, baseUrl: options.baseUrl ?? DEFAULT_BASE_URL, token: options.apiKey });
    this.wallet = new WalletResource(this.http);
    this.cards = new CardsResource(this.http);
    this.transactions = new TransactionsResource(this.http);
    this.approvals = new ApprovalsResource(this.http);
    this.sandbox = new SandboxResource(this.http);
    this.merchants = new MerchantsResource(this.http);
    this.orders = new OrdersResource(this.http);
    this.x402 = new X402Resource(this.http);
  }

  /**
   * Create an organization and its first API key. Unauthenticated.
   * The returned `api_key` is shown once.
   */
  static async signup(input: SignupInput, options: { baseUrl?: string; fetch?: typeof fetch } = {}): Promise<SignupResult> {
    const http = new Http({ baseUrl: options.baseUrl ?? DEFAULT_BASE_URL, token: "", fetch: options.fetch });
    return http.request<SignupResult>("POST", "/v1/signup", { body: input, auth: false });
  }

  /** The organization this key belongs to. */
  async me(): Promise<AccountHolder> {
    return (await this.http.request<{ account_holder: AccountHolder }>("GET", "/v1/auth/me")).account_holder;
  }

  /** Every authorization decision — approved, declined or held — with its reason. */
  async audit(): Promise<CardTransaction[]> {
    return (await this.http.request<{ audit: CardTransaction[] }>("GET", "/v1/audit")).audit;
  }
}

class WalletResource {
  constructor(private readonly http: Http) {}

  /** Balances for every currency the organization holds. */
  async list(): Promise<WalletBalance[]> {
    return (await this.http.request<{ wallets: WalletBalance[] }>("GET", "/v1/wallet")).wallets;
  }

  /** One currency's balance, or the organization's primary currency. */
  async get(currency?: Currency): Promise<WalletBalance> {
    return (await this.http.request<{ wallet: WalletBalance }>("GET", "/v1/wallet", { query: { currency } })).wallet;
  }

  /**
   * Instant credit — the sandbox, and non-ZAR currencies. Deployments with
   * real ZAR funding reject this for ZAR with `instant_funding_disabled`.
   */
  async fund(amount: number, currency?: Currency, options: RequestOptions & { reference?: string } = {}): Promise<WalletBalance> {
    const body = await this.http.request<{ wallet: WalletBalance }>("POST", "/v1/wallet/fund", {
      body: { amount, currency, reference: options.reference },
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
    return body.wallet;
  }
}

class CardsResource {
  constructor(private readonly http: Http) {}

  /** Issue a card. In the sandbox the result carries a test PAN once. */
  async create(input: CreateCardInput = {}, options: RequestOptions = {}): Promise<CreatedCard> {
    return (await this.http.request<{ card: CreatedCard }>("POST", "/v1/cards", { body: input, ...options })).card;
  }

  async list(): Promise<Card[]> {
    return (await this.http.request<{ cards: Card[] }>("GET", "/v1/cards")).cards;
  }

  async get(id: string): Promise<Card> {
    return (await this.http.request<{ card: Card }>("GET", `/v1/cards/${encodeURIComponent(id)}`)).card;
  }

  async close(id: string, options: RequestOptions = {}): Promise<Card> {
    return (await this.http.request<{ card: Card }>("POST", `/v1/cards/${encodeURIComponent(id)}/close`, options)).card;
  }
}

class TransactionsResource {
  constructor(private readonly http: Http) {}

  async list(filter: { cardId?: string } = {}): Promise<CardTransaction[]> {
    return (await this.http.request<{ transactions: CardTransaction[] }>("GET", "/v1/transactions", { query: { card_id: filter.cardId } }))
      .transactions;
  }
}

class ApprovalsResource {
  constructor(private readonly http: Http) {}

  async list(filter: { status?: Approval["status"] } = {}): Promise<Approval[]> {
    return (await this.http.request<{ approvals: Approval[] }>("GET", "/v1/approvals", { query: { status: filter.status } })).approvals;
  }

  async get(id: string): Promise<Approval | undefined> {
    return (await this.list()).find((approval) => approval.id === id);
  }

  /** Mints a single-use grant for this card and merchant, up to the approved amount. */
  async approve(id: string, options: RequestOptions = {}): Promise<Approval> {
    return (await this.http.request<{ approval: Approval }>("POST", `/v1/approvals/${encodeURIComponent(id)}/approve`, options)).approval;
  }

  async deny(id: string, options: RequestOptions = {}): Promise<Approval> {
    return (await this.http.request<{ approval: Approval }>("POST", `/v1/approvals/${encodeURIComponent(id)}/deny`, options)).approval;
  }

  /**
   * Wait until a human decides. Resolves with the decided approval —
   * check `status` (`approved` or `denied`). After `approved`, retry the
   * same charge exactly once: it consumes the grant.
   *
   * Polls, because A-CARD doesn't push approval events to account holders
   * yet (see docs/reference/webhooks.md).
   */
  async waitForDecision(id: string, options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<Approval> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    const interval = options.intervalMs ?? 3_000;
    for (;;) {
      const approval = await this.get(id);
      if (approval && approval.status !== "pending") return approval;
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
      if (Date.now() + interval > deadline) throw new ApprovalTimeoutError(id);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

class SandboxResource {
  constructor(private readonly http: Http) {}

  /**
   * Run a purchase through the real authorization path, playing the card
   * issuer. A decline is a normal result (`approved: false`), not an error.
   */
  async purchase(input: SimulatePurchaseInput, options: RequestOptions = {}): Promise<PurchaseResult> {
    return this.http.request<PurchaseResult>("POST", "/v1/simulate/purchase", { body: input, ...options });
  }
}

class X402Resource {
  constructor(private readonly http: Http) {}

  /**
   * Fetch a URL that charges over x402, paying from the card's budget. The
   * card's limits, categories (must allow `x402`), allowed hosts and approval
   * threshold all apply. A decline or a hold is a normal result, not an error.
   * Requires AFP with x402 enabled on the API.
   */
  async pay(input: X402PayInput, options: RequestOptions = {}): Promise<X402PayResult> {
    return this.http.request<X402PayResult>("POST", "/v1/afp/x402/pay", { body: input, ...options });
  }

  /** What a card has paid over x402 and been charged for it. */
  async tab(cardId: string): Promise<X402Tab> {
    return (await this.http.request<{ tab: X402Tab }>("GET", `/v1/afp/x402/tabs/${encodeURIComponent(cardId)}`)).tab;
  }
}

class MerchantsResource {
  constructor(private readonly http: Http) {}

  /** Ranked offers from verified merchants, plus why the rest were excluded. */
  async search(input: SearchOffersInput = {}): Promise<OfferSearchResult> {
    return this.http.request<OfferSearchResult>("GET", "/v1/merchants/search", { query: { ...input } });
  }

  async list(filter: { status?: PublicMerchant["status"] } = {}): Promise<PublicMerchant[]> {
    return (await this.http.request<{ merchants: PublicMerchant[] }>("GET", "/v1/merchants", { query: { status: filter.status } })).merchants;
  }

  async get(id: string): Promise<{ merchant: PublicMerchant; items: CatalogItem[]; reliability: unknown }> {
    return this.http.request("GET", `/v1/merchants/${encodeURIComponent(id)}`);
  }

  /** Lines are priced from the merchant's catalogue. No money moves through an order. */
  async placeOrder(merchantId: string, input: PlaceOrderInput, options: RequestOptions = {}): Promise<Order> {
    return (await this.http.request<{ order: Order }>("POST", `/v1/merchants/${encodeURIComponent(merchantId)}/orders`, { body: input, ...options }))
      .order;
  }
}

class OrdersResource {
  constructor(private readonly http: Http) {}

  async list(): Promise<Order[]> {
    return (await this.http.request<{ orders: Order[] }>("GET", "/v1/orders")).orders;
  }

  async get(id: string): Promise<Order> {
    return (await this.http.request<{ order: Order }>("GET", `/v1/orders/${encodeURIComponent(id)}`)).order;
  }

  async cancel(id: string, options: RequestOptions = {}): Promise<Order> {
    return (await this.http.request<{ order: Order }>("POST", `/v1/orders/${encodeURIComponent(id)}/cancel`, options)).order;
  }
}
