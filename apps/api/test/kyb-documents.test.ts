import { beforeEach, describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { InMemoryMerchantDirectory } from "../src/merchant/index.js";
import { createApp } from "../src/app.js";
import type { KybDocumentStore } from "../src/kybDocuments.js";

const SECRET = "whsec_test";
const JOBURG = { lat: -26.2041, lng: 28.0473, addressLine: "1 Main Road", city: "Johannesburg", province: "Gauteng", country: "ZA" };

/** A fake object store — records what would have been uploaded without touching S3. */
function fakeStore(): KybDocumentStore & { uploaded: Map<string, { contentType: string }> } {
  const uploaded = new Map<string, { contentType: string }>();
  let n = 0;
  return {
    uploaded,
    async createUploadUrl(merchantId, _filename, contentType) {
      const key = `kyb/${merchantId}/${++n}.pdf`;
      uploaded.set(key, { contentType });
      return { key, uploadUrl: `https://fake-bucket.s3.amazonaws.com/${key}?presigned=1` };
    },
    async createDownloadUrl(key) {
      return `https://fake-bucket.s3.amazonaws.com/${key}?presigned=download`;
    },
  };
}

let platform: Platform;
let store: ReturnType<typeof fakeStore>;
let app: ReturnType<typeof createApp>;
let apiKey: string;

async function json(res: Response) {
  return (await res.json()) as any;
}

function authed(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function registerMerchant() {
  const res = await authed("/v1/merchants", {
    method: "POST",
    body: JSON.stringify({
      name: "Kasi Hardware",
      merchant_category_code: "5211",
      address: JOBURG,
      kyb: { registration_number: "2019/123456/07", contact_email: "orders@example.co.za" },
    }),
  });
  return (await json(res)).merchant.id as string;
}

beforeEach(async () => {
  platform = new Platform();
  store = fakeStore();
  app = createApp({ platform, issuerWebhookSecret: SECRET, merchants: new InMemoryMerchantDirectory(platform.merchants), kybDocuments: store });
  const res = await app.request("/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email: "dev@example.co.za", name: "Dev", currency: "ZAR" }),
    headers: { "content-type": "application/json" },
  });
  apiKey = (await json(res)).api_key;
});

describe("KYB document upload", () => {
  it("requests a presigned upload URL, then records the confirmed document against the merchant", async () => {
    const merchantId = await registerMerchant();

    const request = await authed(`/v1/merchants/${merchantId}/kyb-documents`, {
      method: "POST",
      body: JSON.stringify({ filename: "CIPC-registration.pdf", content_type: "application/pdf" }),
    });
    expect(request.status).toBe(201);
    const { key, upload_url } = await json(request);
    expect(key).toMatch(new RegExp(`^kyb/${merchantId}/`));
    expect(upload_url).toContain("presigned=1");

    // The browser would PUT the file bytes straight to upload_url here — this
    // API never sees them. Only the confirm call, after that PUT succeeds.
    const confirm = await authed(`/v1/merchants/${merchantId}/kyb-documents/confirm`, {
      method: "POST",
      body: JSON.stringify({ key, filename: "CIPC-registration.pdf", content_type: "application/pdf" }),
    });
    expect(confirm.status).toBe(201);
    const confirmed = await json(confirm);
    expect(confirmed.merchant.kyb.documents).toHaveLength(1);
    expect(confirmed.merchant.kyb.documents[0]).toMatchObject({ key, filename: "CIPC-registration.pdf", uploadedBy: "dev@example.co.za" });
  });

  it("refuses to confirm a key that wasn't issued for this merchant", async () => {
    const mine = await registerMerchant();
    const theirs = await registerMerchant();

    const request = await authed(`/v1/merchants/${theirs}/kyb-documents`, {
      method: "POST",
      body: JSON.stringify({ filename: "doc.pdf", content_type: "application/pdf" }),
    });
    const { key } = await json(request);

    const confirm = await authed(`/v1/merchants/${mine}/kyb-documents/confirm`, {
      method: "POST",
      body: JSON.stringify({ key, filename: "doc.pdf", content_type: "application/pdf" }),
    });
    expect(confirm.status).toBe(400);
    expect((await json(confirm)).error.code).toBe("invalid_key");
  });

  it("lists confirmed documents with fresh download URLs", async () => {
    const merchantId = await registerMerchant();
    const { key } = await json(
      await authed(`/v1/merchants/${merchantId}/kyb-documents`, {
        method: "POST",
        body: JSON.stringify({ filename: "doc.pdf", content_type: "application/pdf" }),
      }),
    );
    await authed(`/v1/merchants/${merchantId}/kyb-documents/confirm`, {
      method: "POST",
      body: JSON.stringify({ key, filename: "doc.pdf", content_type: "application/pdf" }),
    });

    const list = await json(await authed(`/v1/merchants/${merchantId}/kyb-documents`));
    expect(list.documents).toHaveLength(1);
    expect(list.documents[0].download_url).toContain("presigned=download");
  });

  it("rejects a disallowed content type", async () => {
    const merchantId = await registerMerchant();
    const res = await authed(`/v1/merchants/${merchantId}/kyb-documents`, {
      method: "POST",
      body: JSON.stringify({ filename: "malware.exe", content_type: "application/x-msdownload" }),
    });
    expect(res.status).toBe(400);
  });

  it("only an admin can request or confirm an upload", async () => {
    const merchantId = await registerMerchant();
    const roRes = await authed("/v1/keys", { method: "POST", body: JSON.stringify({ name: "ro", scope: "read_only" }) });
    const roKey = (await json(roRes)).api_key;
    const res = await app.request(`/v1/merchants/${merchantId}/kyb-documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${roKey}`, "content-type": "application/json" },
      body: JSON.stringify({ filename: "doc.pdf", content_type: "application/pdf" }),
    });
    expect(res.status).toBe(403);
  });

  it("never exposes documents through the agent-facing merchant view", async () => {
    const merchantId = await registerMerchant();
    const { key } = await json(
      await authed(`/v1/merchants/${merchantId}/kyb-documents`, {
        method: "POST",
        body: JSON.stringify({ filename: "sensitive-doc.pdf", content_type: "application/pdf" }),
      }),
    );
    await authed(`/v1/merchants/${merchantId}/kyb-documents/confirm`, {
      method: "POST",
      body: JSON.stringify({ key, filename: "sensitive-doc.pdf", content_type: "application/pdf" }),
    });
    await authed(`/v1/merchants/${merchantId}/kyb`, { method: "POST", body: JSON.stringify({ status: "verified" }) });

    const body = await (await authed(`/v1/merchants/${merchantId}`)).text();
    expect(body).not.toContain("sensitive-doc.pdf");
    expect(body).not.toContain(key);
  });
});

describe("without kybDocuments configured", () => {
  it("stays unmounted, and onboarding/KYB still work", async () => {
    const bare = new Platform();
    const bareApp = createApp({ platform: bare, issuerWebhookSecret: SECRET, merchants: new InMemoryMerchantDirectory(bare.merchants) });
    const signup = await bareApp.request("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email: "dev2@example.co.za", name: "Dev" }),
      headers: { "content-type": "application/json" },
    });
    const key = (await json(signup)).api_key;
    const create = await bareApp.request("/v1/merchants", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Kasi Hardware",
        merchant_category_code: "5211",
        address: JOBURG,
        kyb: { registration_number: "2019/1/07", contact_email: "orders@example.co.za" },
      }),
    });
    expect(create.status).toBe(201);
    const merchantId = (await json(create)).merchant.id;
    expect(
      (
        await bareApp.request(`/v1/merchants/${merchantId}/kyb`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ status: "verified" }),
        })
      ).status,
    ).toBe(200);
    expect((await bareApp.request(`/v1/merchants/${merchantId}/kyb-documents`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(
      404,
    );
  });
});
