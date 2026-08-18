import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Platform, signWebhook } from "@acard/core";
import { createApp } from "../src/app.js";
import type { IssuerCardClient, ProvisionedIssuerCard } from "../src/sudo.js";

/**
 * The real-issuer wiring over HTTP, exercised against a fake `IssuerCardClient`
 * — the actual Sudo wire format is unverified (see sudo.ts's header), but this
 * proves the part that doesn't depend on it: card creation calling the issuer,
 * Card.issuerCardId getting linked, provisioning failures closing the card
 * instead of leaving a phantom active one, and — the money-safety-critical
 * part — the issuer webhook authorizing correctly when it identifies the card
 * by *its own* reference rather than ours.
 */
const SECRET = "whsec_test";

function fakeIssuer(overrides: Partial<IssuerCardClient> = {}): IssuerCardClient {
  let counter = 0;
  return {
    async createCard(input): Promise<ProvisionedIssuerCard> {
      counter += 1;
      return { issuerCardId: `sudo_card_${counter}`, last4: "4242", expiryMonth: 12, expiryYear: 2030 };
    },
    ...overrides,
  };
}

let app: ReturnType<typeof createApp>;

async function json(res: Response) {
  return (await res.json()) as any;
}

function withToken(path: string, token: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function signedWebhook(body: object) {
  const raw = JSON.stringify(body);
  return app.request("/webhooks/issuer", {
    method: "POST",
    body: raw,
    headers: { "x-acard-signature": signWebhook(raw, SECRET) },
  });
}

describe("issuer not configured (default)", () => {
  beforeEach(() => {
    app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET }); // no `sudo` config
  });

  it("card creation is unchanged: sandbox PAN, no issuerCardId, no network call", async () => {
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken("/v1/cards", signup.api_key, { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    const { card } = await json(res);
    expect(card.sandboxPan.startsWith("4242")).toBe(true);
    expect(card.issuerCardId).toBeUndefined();
  });
});

describe("issuer configured", () => {
  let apiKey: string;

  beforeEach(async () => {
    app = createApp({ platform: new Platform(), issuerWebhookSecret: SECRET, sudo: fakeIssuer() });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev@acard.co.za", name: "Dev", currency: "ZAR" }),
        headers: { "content-type": "application/json" },
      }),
    );
    apiKey = signup.api_key;
    await withToken("/v1/wallet/fund", apiKey, { method: "POST", body: JSON.stringify({ amount: 100_000 }) });
  });

  it("links the issuer's card reference on the created card", async () => {
    const res = await withToken("/v1/cards", apiKey, { method: "POST", body: "{}" });
    expect(res.status).toBe(201);
    const { card } = await json(res);
    expect(card.issuerCardId).toBe("sudo_card_1");
  });

  it("closes the card and fails the request when the issuer refuses to provision it", async () => {
    app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      sudo: fakeIssuer({
        async createCard() {
          throw new Error("issuer sandbox is down");
        },
      }),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev2@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await withToken("/v1/cards", signup.api_key, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe("issuer_provisioning_failed");

    // The card must not be left active with no real card behind it.
    const cards = await json(await withToken("/v1/cards", signup.api_key));
    expect(cards.cards).toHaveLength(1);
    expect(cards.cards[0].status).toBe("closed");
    expect(cards.cards[0].closeReason).toBe("issuer_provisioning_failed");
  });

  it("authorizes a webhook that identifies the card by the issuer's own reference, not ours", async () => {
    const created = await json(await withToken("/v1/cards", apiKey, { method: "POST", body: "{}" }));
    expect(created.card.issuerCardId).toBe("sudo_card_1");

    // The issuer's webhook would never know our internal card.id — only its own reference.
    const res = await signedWebhook({
      id: "evt_1",
      type: "authorization.request",
      data: {
        authorization_id: "auth_via_sudo_ref",
        card_id: created.card.issuerCardId,
        amount: 12_000,
        currency: "ZAR",
        merchant: { name: "Checkers Sixty60", category: "5411" },
      },
    });
    expect(res.status).toBe(200);
    const decision = await json(res);
    expect(decision.approved).toBe(true);

    // The transaction and card views are keyed on OUR id, not the issuer's token.
    const txs = await json(await withToken("/v1/transactions", apiKey));
    expect(txs.transactions).toHaveLength(1);
    expect(txs.transactions[0].cardId).toBe(created.card.id);

    const wallet = await json(await withToken("/v1/wallet", apiKey));
    expect(wallet.wallet.held).toBe(12_000);
  });

  it("declines a policy-blocked purchase routed via the issuer reference, still recording our card id", async () => {
    const created = await json(
      await withToken("/v1/cards", apiKey, {
        method: "POST",
        body: JSON.stringify({ allowed_merchant_categories: ["5411"] }),
      }),
    );

    const res = await signedWebhook({
      id: "evt_2",
      type: "authorization.request",
      data: {
        authorization_id: "auth_declined_via_sudo",
        card_id: created.card.issuerCardId,
        amount: 5_000,
        currency: "ZAR",
        merchant: { name: "Steam", category: "5816" },
      },
    });
    const decision = await json(res);
    expect(decision.approved).toBe(false);

    const txs = await json(await withToken("/v1/transactions", apiKey));
    expect(txs.transactions[0].cardId).toBe(created.card.id);
  });

  it("rejects two cards whose issuer provisioning returns the same reference", async () => {
    let call = 0;
    app = createApp({
      platform: new Platform(),
      issuerWebhookSecret: SECRET,
      sudo: fakeIssuer({
        async createCard() {
          call += 1;
          return { issuerCardId: "sudo_card_shared" }; // deliberately identical every time
        },
      }),
    });
    const signup = await json(
      await app.request("/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email: "dev3@acard.co.za", name: "Dev" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const first = await withToken("/v1/cards", signup.api_key, { method: "POST", body: "{}" });
    expect(first.status).toBe(201);

    const second = await withToken("/v1/cards", signup.api_key, { method: "POST", body: "{}" });
    expect(second.status).toBe(502); // the linkIssuerCard collision surfaces as a provisioning failure
    expect(call).toBe(2);
  });
});
