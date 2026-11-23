import { describe, expect, it } from "vitest";
import { Acard } from "../src/index.js";

describe("partner SDK", () => {
  it("sends A-Card-Customer only on the forCustomer client", async () => {
    const seen: Array<{ url: string; customer: string | null; auth: string | null }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url: String(url), customer: h.get("a-card-customer"), auth: h.get("authorization") });
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    const acard = new Acard({ apiKey: "ak_test_partner", baseUrl: "https://api.test", fetch });
    await acard.partner.customers.list();
    await acard.forCustomer("user-42").cards.list();
    await acard.partner.revenue("2026-11");
    expect(seen).toEqual([
      { url: "https://api.test/v1/partner/customers", customer: null, auth: "Bearer ak_test_partner" },
      { url: "https://api.test/v1/cards", customer: "user-42", auth: "Bearer ak_test_partner" },
      { url: "https://api.test/v1/partner/revenue?month=2026-11", customer: null, auth: "Bearer ak_test_partner" },
    ]);
  });
});
