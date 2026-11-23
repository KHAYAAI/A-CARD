import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { DomainError, type AccountHolder } from "@acard/core";
import type { PlatformService } from "../service/types.js";
import { currentMonth, customerLine, monthBounds, statement } from "./revenue.js";
import { DEFAULT_TERMS, type Brand, type Partner, type PartnerStore } from "./types.js";

const holderOf = (c: any) => c.get("holder") as AccountHolder;
export const CUSTOMER_HEADER = "a-card-customer";
export const DEFAULT_BRAND: Brand = { displayName: "A-CARD", supportEmail: "support@a-card.cc", supportUrl: "https://a-card.cc" };

export interface PartnerConfig {
  store: PartnerStore;
  /** Bearer token for /v1/operator/* (A-CARD staff only). Unset: operator routes are off. */
  operatorToken?: string;
  /** Terms applied to new partners until the operator changes them. */
  defaultTerms?: typeof DEFAULT_TERMS;
}

const https = z.string().url().max(500).refine((u) => u.startsWith("https://"), "must be an https URL");
const brandSchema = z.object({
  display_name: z.string().trim().min(2).max(60),
  logo_url: https.optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "primary_color must be #RRGGBB").optional(),
  support_email: z.string().email().max(200).optional(),
  support_url: https.optional(),
});
const toBrand = (b: z.infer<typeof brandSchema>): Brand => ({ displayName: b.display_name, logoUrl: b.logo_url, primaryColor: b.primary_color, supportEmail: b.support_email, supportUrl: b.support_url });
const brandView = (b: Brand) => ({ display_name: b.displayName, logo_url: b.logoUrl ?? null, primary_color: b.primaryColor ?? null, support_email: b.supportEmail ?? null, support_url: b.supportUrl ?? null });
const partnerView = (p: Partner) => ({ id: p.id, account_holder_id: p.accountHolderId, name: p.name, brand: brandView(p.brand), terms: { volume_bps: p.terms.volumeBps, per_active_card: p.terms.perActiveCard, monthly_minimum: p.terms.monthlyMinimum, currency: p.terms.currency }, distributor_id: p.distributorId ?? null, created_at: p.createdAt });
const monthOf = (q: string | undefined) => { const m = q ?? currentMonth(); try { monthBounds(m); } catch { throw new DomainError("invalid_request", "month must be YYYY-MM"); } return m; };

/**
 * Lets a partner's credential act for one of its customers. Runs after the
 * normal auth guard: swaps `holder` for the customer's account only when the
 * header names a customer this partner created. The partner's own role
 * carries over (a read-only partner key stays read-only).
 */
export function actAsCustomer(platform: PlatformService, store: PartnerStore): MiddlewareHandler<any> {
  return async (c: any, next: any) => {
    const target = c.req.header(CUSTOMER_HEADER);
    if (!target) return next();
    const holder = c.get("holder") as AccountHolder | undefined;
    if (!holder) return next();
    if (c.req.path.startsWith("/v1/partner")) return c.json({ error: { code: "invalid_request", message: "partner routes act for the partner itself; drop the A-Card-Customer header" } }, 400);
    const partner = await store.getPartnerByHolder(holder.id);
    if (!partner) return c.json({ error: { code: "forbidden", message: "only a partner account can act for a customer" } }, 403);
    const link = (await store.getCustomer(partner.id, target)) ?? (await store.getCustomerByRef(partner.id, target));
    if (!link) return c.json({ error: { code: "not_found", message: "no such customer for this partner" } }, 404);
    const customer = await platform.getAccountHolder(link.accountHolderId);
    if (!customer) return c.json({ error: { code: "not_found", message: "no such customer for this partner" } }, 404);
    c.set("holder", customer);
    c.set("partnerActor", { partnerId: partner.id, partnerHolderId: holder.id });
    c.header("A-Card-Acting-For", customer.id);
    return next();
  };
}

export function mountPartnerRoutes(
  app: Hono<any>,
  deps: { platform: PlatformService; cfg: PartnerConfig; requireAdmin: MiddlewareHandler<any>; provisionWallet: (id: string) => Promise<void> },
) {
  const { platform, cfg, requireAdmin } = deps;
  const { store } = cfg;
  const mine = async (holderId: string) => {
    const p = await store.getPartnerByHolder(holderId);
    if (!p) throw new DomainError("not_a_partner", "this account is not a partner yet: POST /v1/partner first", 404);
    return p;
  };

  // ---- branding: what any signed-in account should look like ---------------
  app.get("/v1/branding", async (c: any) => {
    const h = holderOf(c);
    const own = await store.getPartnerByHolder(h.id);
    const link = own ? undefined : await store.getCustomerByHolder(h.id);
    const p = own ?? (link && (await store.getPartner(link.partnerId)));
    return c.json({ white_label: Boolean(p), partner_id: p?.id ?? null, brand: brandView(p?.brand ?? DEFAULT_BRAND), powered_by: "A-CARD" });
  });

  // ---- the partner's own account ---------------------------------------------
  app.post("/v1/partner", requireAdmin, async (c: any) => {
    const h = holderOf(c);
    if (await store.getCustomerByHolder(h.id)) throw new DomainError("forbidden", "a partner's customer cannot become a partner", 403);
    if (await store.getPartnerByHolder(h.id)) throw new DomainError("conflict", "this account is already a partner", 409);
    const body = z.object({ name: z.string().trim().min(2).max(100), brand: brandSchema.optional() }).parse(await c.req.json());
    const p: Partner = { id: `ptn_${randomUUID().replace(/-/g, "").slice(0, 20)}`, accountHolderId: h.id, name: body.name, brand: body.brand ? toBrand(body.brand) : { displayName: body.name }, terms: { ...(cfg.defaultTerms ?? DEFAULT_TERMS) }, createdAt: new Date().toISOString() };
    await store.insertPartner(p);
    return c.json(partnerView(p), 201);
  });
  app.get("/v1/partner", async (c: any) => c.json(partnerView(await mine(holderOf(c).id))));
  app.put("/v1/partner/brand", requireAdmin, async (c: any) => {
    const p = await mine(holderOf(c).id);
    p.brand = toBrand(brandSchema.parse(await c.req.json()));
    await store.updatePartner(p);
    return c.json(partnerView(p));
  });

  // ---- customers ----------------------------------------------------------------
  app.post("/v1/partner/customers", requireAdmin, async (c: any) => {
    const p = await mine(holderOf(c).id);
    const body = z.object({
      email: z.string().email().max(200),
      name: z.string().trim().min(1).max(200),
      external_ref: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "external_ref: letters, digits, _ . : - (max 100)").optional(),
      currency: z.string().length(3).optional(),
      account_type: z.enum(["personal", "enterprise"]).optional(),
    }).parse(await c.req.json());
    if (body.external_ref && (await store.getCustomerByRef(p.id, body.external_ref))) throw new DomainError("conflict", "a customer with that external_ref exists", 409);
    const holder = await platform.signup({ email: body.email, name: body.name, currency: body.currency as any, accountType: body.account_type });
    await store.insertCustomer({ partnerId: p.id, accountHolderId: holder.id, externalRef: body.external_ref, createdAt: new Date().toISOString() });
    await deps.provisionWallet(holder.id);
    return c.json({ customer: { account_holder_id: holder.id, external_ref: body.external_ref ?? null, name: holder.name, email: holder.email, currency: holder.currency }, act_as: { header: "A-Card-Customer", value: holder.id } }, 201);
  });
  app.get("/v1/partner/customers", async (c: any) => {
    const p = await mine(holderOf(c).id);
    const links = await store.listCustomers(p.id);
    const rows = await Promise.all(links.map(async (l) => {
      const h = await platform.getAccountHolder(l.accountHolderId);
      return { account_holder_id: l.accountHolderId, external_ref: l.externalRef ?? null, name: h?.name ?? null, email: h?.email ?? null, currency: h?.currency ?? null, created_at: l.createdAt };
    }));
    return c.json({ data: rows });
  });
  app.get("/v1/partner/customers/:id", async (c: any) => {
    const p = await mine(holderOf(c).id);
    const id = c.req.param("id") as string;
    const l = (await store.getCustomer(p.id, id)) ?? (await store.getCustomerByRef(p.id, id));
    if (!l) throw new DomainError("not_found", "no such customer for this partner", 404);
    const [h, cards, txs] = await Promise.all([platform.getAccountHolder(l.accountHolderId), platform.listCards(l.accountHolderId), platform.listTransactions({ accountHolderId: l.accountHolderId })]);
    const line = customerLine(l.accountHolderId, l.externalRef, txs, currentMonth());
    return c.json({ account_holder_id: l.accountHolderId, external_ref: l.externalRef ?? null, name: h?.name, email: h?.email, cards: { total: cards.length, active: cards.filter((x: any) => x.status === "active").length }, this_month: { volume: line.volume, active_cards: line.activeCards, transactions: line.transactions } });
  });

  const buildStatement = async (p: Partner, month: string) => {
    const links = await store.listCustomers(p.id);
    const lines = await Promise.all(links.map(async (l) => customerLine(l.accountHolderId, l.externalRef, await platform.listTransactions({ accountHolderId: l.accountHolderId }), month)));
    const d = p.distributorId ? await store.getDistributor(p.distributorId) : undefined;
    return statement(p, month, lines, d);
  };
  const statementView = (s: Awaited<ReturnType<typeof buildStatement>>, withDistributor: boolean) => ({
    partner_id: s.partnerId, partner_name: s.partnerName, month: s.month,
    terms: { volume_bps: s.terms.volumeBps, per_active_card: s.terms.perActiveCard, monthly_minimum: s.terms.monthlyMinimum, currency: s.terms.currency },
    volume: s.volume, active_cards: s.activeCards,
    fees: { volume: s.fees.volume, active_cards: s.fees.activeCards, minimum_top_up: s.fees.minimumTopUp, total: s.fees.total },
    customers: s.customers.map((x) => ({ account_holder_id: x.accountHolderId, external_ref: x.externalRef ?? null, volume: x.volume, active_cards: x.activeCards, transactions: x.transactions })),
    ...(withDistributor && s.distributor ? { distributor: { id: s.distributor.id, name: s.distributor.name, share_bps: s.distributor.shareBps, payout: s.distributor.payout } } : {}),
    amounts: "minor units (cents) per currency",
  });
  app.get("/v1/partner/revenue", async (c: any) => {
    const p = await mine(holderOf(c).id);
    return c.json(statementView(await buildStatement(p, monthOf(c.req.query("month"))), false));
  });

  // ---- operator (A-CARD staff): terms, distributors, all statements ---------
  const opHash = cfg.operatorToken ? createHash("sha256").update(cfg.operatorToken).digest() : undefined;
  const operator: MiddlewareHandler<any> = async (c: any, next: any) => {
    const h = c.req.header("authorization") ?? "";
    const given = createHash("sha256").update(h.startsWith("Bearer ") ? h.slice(7) : "").digest();
    if (!opHash || !timingSafeEqual(given, opHash)) return c.json({ error: { code: "unauthorized", message: "operator token required" } }, 401);
    return next();
  };
  app.use("/v1/operator/*", operator);
  app.post("/v1/operator/distributors", async (c: any) => {
    const b = z.object({ name: z.string().trim().min(2).max(100), share_bps: z.number().int().min(0).max(5000) }).parse(await c.req.json());
    const d = { id: `dst_${randomUUID().replace(/-/g, "").slice(0, 20)}`, name: b.name, shareBps: b.share_bps, createdAt: new Date().toISOString() };
    await store.insertDistributor(d);
    return c.json({ id: d.id, name: d.name, share_bps: d.shareBps, created_at: d.createdAt }, 201);
  });
  app.get("/v1/operator/distributors", async (c: any) => c.json({ data: (await store.listDistributors()).map((d) => ({ id: d.id, name: d.name, share_bps: d.shareBps, created_at: d.createdAt })) }));
  app.get("/v1/operator/partners", async (c: any) => c.json({ data: (await store.listPartners()).map(partnerView) }));
  app.put("/v1/operator/partners/:id", async (c: any) => {
    const p = await store.getPartner(c.req.param("id") as string);
    if (!p) throw new DomainError("not_found", "no such partner", 404);
    const b = z.object({
      volume_bps: z.number().int().min(0).max(1000).optional(),
      per_active_card: z.number().int().min(0).optional(),
      monthly_minimum: z.number().int().min(0).optional(),
      currency: z.string().length(3).optional(),
      distributor_id: z.string().nullable().optional(),
    }).parse(await c.req.json());
    if (b.distributor_id && !(await store.getDistributor(b.distributor_id))) throw new DomainError("not_found", "no such distributor", 404);
    p.terms = { volumeBps: b.volume_bps ?? p.terms.volumeBps, perActiveCard: b.per_active_card ?? p.terms.perActiveCard, monthlyMinimum: b.monthly_minimum ?? p.terms.monthlyMinimum, currency: (b.currency ?? p.terms.currency).toUpperCase() };
    if (b.distributor_id !== undefined) p.distributorId = b.distributor_id ?? undefined;
    await store.updatePartner(p);
    return c.json(partnerView(p));
  });
  app.get("/v1/operator/revenue", async (c: any) => {
    const month = monthOf(c.req.query("month"));
    const statements = await Promise.all((await store.listPartners()).map((p) => buildStatement(p, month)));
    const byDistributor: Record<string, { id: string; name: string; share_bps: number; partners: string[]; payout: Record<string, number> }> = {};
    const totals: Record<string, number> = {};
    for (const s of statements) {
      for (const [k, v] of Object.entries(s.fees.total)) totals[k] = (totals[k] ?? 0) + v;
      if (!s.distributor) continue;
      const d = (byDistributor[s.distributor.id] ??= { id: s.distributor.id, name: s.distributor.name, share_bps: s.distributor.shareBps, partners: [], payout: {} });
      d.partners.push(s.partnerId);
      for (const [k, v] of Object.entries(s.distributor.payout)) d.payout[k] = (d.payout[k] ?? 0) + v;
    }
    return c.json({ month, partners: statements.map((s) => statementView(s, true)), distributors: Object.values(byDistributor), fees_total: totals, amounts: "minor units (cents) per currency" });
  });
}
