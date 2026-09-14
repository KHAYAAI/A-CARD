import type {
  Availability,
  CatalogItem,
  KybDocument,
  Merchant,
  MerchantApiContext,
  MerchantApiKey,
  MerchantApiKeyScope,
  MerchantInvite,
  MerchantRole,
  MerchantSessionContext,
  MerchantStatus,
  MerchantUser,
  MerchantReliability,
  MerchantWebhook,
  OfferQuery,
  OfferSearchResult,
  Order,
  OrderStatus,
  PlaceOrderInput,
  PurchaseNotice,
  PurchaseNoticeStatus,
  RegisterMerchantInput,
  ReportPurchaseInput,
  UpsertItemInput,
} from "@acard/core";

/**
 * The async ports app.ts's A-MERCHANT routes depend on — deliberately mirroring
 * `MerchantDirectory`/`MerchantAuthService`'s own method names and shapes, one
 * method at a time made `Promise`-returning. Two implementations:
 *
 *   - `InMemoryMerchantDirectory`/`InMemoryMerchantAuth` (memory.ts) — wraps
 *     the synchronous `packages/core` classes for the sandbox and single-writer
 *     snapshot deployment path.
 *   - `PostgresMerchantDirectory`/`PostgresMerchantAuth` (postgres.ts) — a
 *     real multi-writer store, so A-MERCHANT can run alongside A-CARD's own
 *     Postgres multi-writer path without either giving up multi-instance
 *     safety.
 *
 * Same pattern as `apps/api/src/service/types.ts`'s `PlatformService` port —
 * app.ts (and every test) depends only on this interface, never on which
 * backend is behind it.
 */
export interface MerchantDirectoryPort {
  register(input: RegisterMerchantInput): Promise<Merchant>;
  get(id: string): Promise<Merchant>;
  list(filter?: { status?: MerchantStatus }): Promise<Merchant[]>;
  setStatus(id: string, status: MerchantStatus, reviewedBy: string, note?: string): Promise<Merchant>;
  attachKybDocument(id: string, doc: Omit<KybDocument, "uploadedAt">): Promise<Merchant>;
  updateProfile(
    id: string,
    patch: Partial<Pick<Merchant, "name" | "tradingName" | "address" | "serviceRadiusKm" | "agentAccess" | "allowedAccountHolderIds" | "merchantCategoryCode" | "operatingHours" | "webhook">>,
  ): Promise<Merchant>;
  upsertItem(merchantId: string, input: UpsertItemInput): Promise<CatalogItem>;
  restate(itemId: string, state: { availability: Availability; quantityAvailable?: number }): Promise<CatalogItem>;
  getItem(id: string): Promise<CatalogItem>;
  listItems(merchantId: string): Promise<CatalogItem[]>;
  removeItem(id: string): Promise<void>;
  catalogHealth(
    merchantId: string,
  ): Promise<{ items: number; fresh: number; aging: number; stale: number; medianInventoryAgeHours: number }>;
  search(query: OfferQuery): Promise<OfferSearchResult>;
  reportPurchase(input: ReportPurchaseInput): Promise<PurchaseNotice>;
  getPurchase(id: string): Promise<PurchaseNotice>;
  listPurchases(merchantId: string, filter?: { status?: PurchaseNoticeStatus }): Promise<PurchaseNotice[]>;
  listPurchasesByBuyer(accountHolderId: string): Promise<PurchaseNotice[]>;
  resolvePurchase(id: string, status: "acknowledged" | "disputed", note?: string): Promise<PurchaseNotice>;
  pendingPurchaseCount(merchantId: string): Promise<number>;

  // -- orders ---------------------------------------------------------------
  placeOrder(input: PlaceOrderInput): Promise<Order>;
  getOrder(id: string): Promise<Order>;
  listOrders(merchantId: string, filter?: { status?: OrderStatus }): Promise<Order[]>;
  listOrdersByBuyer(accountHolderId: string): Promise<Order[]>;
  advanceOrder(
    id: string,
    to: OrderStatus,
    by: "buyer" | "merchant",
    detail?: { note?: string; promisedAt?: string; trackingReference?: string },
  ): Promise<Order>;
  openOrderCount(merchantId: string): Promise<number>;
  reliability(merchantId: string): Promise<MerchantReliability>;

  /** Where this merchant's system wants events pushed. Secret is returned once. */
  setWebhook(merchantId: string, input: { url: string; events?: string[] }): Promise<{ webhook: MerchantWebhook; secret: string }>;
  clearWebhook(merchantId: string): Promise<void>;
  recordWebhookDelivery(merchantId: string, ok: boolean): Promise<void>;
}

export interface MerchantAuthPort {
  createInvite(merchantId: string, role: MerchantRole, issuedBy: string): Promise<{ invite: MerchantInvite; token: string }>;
  peekInvite(token: string): Promise<MerchantInvite | undefined>;
  redeemInvite(token: string, workosUser: { workosUserId: string; email: string; name: string }): Promise<MerchantUser>;
  listInvites(merchantId: string): Promise<MerchantInvite[]>;
  getUser(id: string): Promise<MerchantUser>;
  listUsers(merchantId: string): Promise<MerchantUser[]>;
  createSession(user: MerchantUser): Promise<{ token: string; context: MerchantSessionContext }>;
  resolveSession(token: string): Promise<MerchantSessionContext | undefined>;
  revokeSession(token: string): Promise<void>;

  /** Machine credentials — one merchant's POS/ERP integration. See merchantAuth.ts. */
  createApiKey(
    merchantId: string,
    input: { name: string; scope?: MerchantApiKeyScope; createdBy: string },
  ): Promise<{ apiKey: MerchantApiKey; secret: string }>;
  listApiKeys(merchantId: string): Promise<MerchantApiKey[]>;
  resolveApiKey(secret: string): Promise<MerchantApiContext | undefined>;
  revokeApiKey(merchantId: string, apiKeyId: string): Promise<MerchantApiKey>;
}
