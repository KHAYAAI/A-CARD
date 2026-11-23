import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";
import { InMemoryPlatformService } from "../src/service/index.js";
import { MemoryPartnerStore } from "../src/partners/index.js";

const OP = "op-token-".padEnd(40, "x");

describe("platform partners", () => {
  let svc: InMemoryPlatformService;
  let app: ReturnType<typeof createApp>;
  let key: string;
  const req = (path: string, init: { method?: string; body?: unknown; key?: string; customer?: string } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { authorization: `Bearer ${init.key ?? key}`, "content-type": "application/json", ...(init.customer ? { "a-card-customer": init.customer } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const json = async (r: Response | Promise<Response>) => { const x = await r; return { status: x.status, body: (await x.json()) as any }; };

  beforeEach(async () => {
    svc = new InMemoryPlatformService(new Platform());
    app = createApp({ platform: svc, issuerWebhookSecret: "s".repeat(32), partners: { store: new MemoryPartnerStore(), operatorToken: OP } } as any);
    const s = await json(app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "platform@agents.dev", name: "AgentsDev", currency: "USD" }) }));
    key = s.body.api_key;
  });

  const becomePartner = () => json(req("/v1/partner", { body: { name: "AgentsDev", brand: { display_name: "AgentsDev Pay", logo_url: "https://agents.dev/logo.png", primary_color: "#112233", support_email: "help@agents.dev" } } }));

  it("onboards a partner, creates customers, and acts for them on existing routes", async () => {
    const p = await becomePartner();
    expect(p.status).toBe(201);
    expect(p.body.terms).toEqual({ volume_bps: 100, per_active_card: 50, monthly_minimum: 30000, currency: "USD" });
    expect((await becomePartner()).status).toBe(409);

    const c = await json(req("/v1/partner/customers", { body: { email: "ann@example.com", name: "Ann", external_ref: "user-42", currency: "USD" } }));
    expect(c.status).toBe(201);
    const ann = c.body.customer.account_holder_id;

    // Existing card route, for the customer, via header (by id and by external ref).
    const card = await json(req("/v1/cards", { body: { label: "Ann's agent" }, customer: ann }));
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    expect((await svc.listCards(ann)).length).toBe(1);
    const byRef = await json(req("/v1/cards", { customer: "user-42" }));
    expect(byRef.status).toBe(200);
    // The partner's own account has no cards: acting was scoped.
    const me = await json(req("/v1/partner"));
    expect((await svc.listCards(me.body.account_holder_id)).length).toBe(0);

    // Branding resolves to the partner's for the customer.
    const b = await json(req("/v1/branding", { customer: ann }));
    expect(b.body).toMatchObject({ white_label: true, brand: { display_name: "AgentsDev Pay", primary_color: "#112233" }, powered_by: "A-CARD" });
    expect((await json(req("/v1/partner/customers"))).body.data).toHaveLength(1);
  });

  it("refuses customers that aren't yours, non-partners, and partner routes while acting", async () => {
    const other = await json(app.request("/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "rival@x.dev", name: "Rival" }) }));
    expect((await req("/v1/cards", { customer: other.body.account_holder.id })).status).toBe(403); // not a partner yet
    await becomePartner();
    expect((await req("/v1/cards", { customer: other.body.account_holder.id })).status).toBe(404); // not its customer
    const c = await json(req("/v1/partner/customers", { body: { email: "bo@example.com", name: "Bo" } }));
    expect((await req("/v1/partner/customers", { customer: c.body.customer.account_holder_id })).status).toBe(400);
    // A customer can't become a partner.
    expect((await req("/v1/partner", { body: { name: "Nope" }, customer: c.body.customer.account_holder_id })).status).toBe(400);
    // Brand validation: https only.
    expect((await req("/v1/partner/brand", { method: "PUT", body: { display_name: "X Pay", logo_url: "http://insecure/logo.png" } })).status).toBe(400);
  });

  it("reports revenue share per partner and per distributor", async () => {
    const p = await becomePartner();
    const op = (path: string, body?: unknown, method?: string) => json(app.request(path, { method: method ?? (body ? "POST" : "GET"), headers: { authorization: `Bearer ${OP}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
    expect((await json(req("/v1/operator/partners"))).status).toBe(401); // a tenant key is not the operator
    const d = await op("/v1/operator/distributors", { name: "Agent Tools Hub", share_bps: 2000 });
    expect(d.status).toBe(201);
    expect((await op(`/v1/operator/partners/${p.body.id}`, { volume_bps: 100, per_active_card: 50, monthly_minimum: 30000, distributor_id: d.body.id }, "PUT")).status).toBe(200);

    const month = new Date().toISOString().slice(0, 7);
    for (const [i, email] of ["a@x.com", "b@x.com"].entries()) {
      const c = await json(req("/v1/partner/customers", { body: { email, name: `C${i}`, currency: "USD" } }));
      const id = c.body.customer.account_holder_id;
      await svc.fundWallet(id, 10_000_000, "USD" as any);
      const card = await svc.createCard({ accountHolderId: id, singleUse: false, currency: "USD" } as any);
      for (let k = 0; k < 2; k++) {
        const authorizationId = `auth_${i}_${k}`;
        const dec = await svc.authorize({ authorizationId, cardId: card.id, amount: 2_000, currency: "USD" as any, merchant: { name: "Shop", category: "5999" } });
        expect(dec.approved, JSON.stringify(dec)).toBe(true);
        await svc.capture(authorizationId);
      }
    }
    const s = await json(req(`/v1/partner/revenue?month=${month}`));
    expect(s.status).toBe(200);
    expect(s.body.volume).toEqual({ USD: 8_000 }); // $80
    expect(s.body.active_cards).toBe(2);
    // 1% of $80 = $0.80, 2 active cards x $0.50 = $1.00, topped up to the $300 minimum.
    expect(s.body.fees).toEqual({ volume: { USD: 80 }, active_cards: 100, minimum_top_up: 29_820, total: { USD: 30_000 } });
    expect(s.body.distributor).toBeUndefined(); // partners don't see the distributor's cut

    const all = await op(`/v1/operator/revenue?month=${month}`);
    expect(all.body.distributors).toEqual([{ id: d.body.id, name: "Agent Tools Hub", share_bps: 2000, partners: [p.body.id], payout: { USD: 6_000 } }]);
    expect(all.body.fees_total).toEqual({ USD: 30_000 });

    // An empty month still bills the minimum.
    const empty = await json(req("/v1/partner/revenue?month=2020-01"));
    expect(empty.body.fees.total).toEqual({ USD: 30_000 });
    expect((await req("/v1/partner/revenue?month=2020-13")).status).toBe(400);
  });
});
