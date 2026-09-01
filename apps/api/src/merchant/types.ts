import type {
  Availability,
  CatalogItem,
  KybDocument,
  Merchant,
  MerchantInvite,
  MerchantRole,
  MerchantSessionContext,
  MerchantStatus,
  MerchantUser,
  OfferQuery,
  OfferSearchResult,
  RegisterMerchantInput,
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
    patch: Partial<Pick<Merchant, "name" | "tradingName" | "address" | "serviceRadiusKm" | "agentAccess" | "allowedAccountHolderIds" | "merchantCategoryCode">>,
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
}
