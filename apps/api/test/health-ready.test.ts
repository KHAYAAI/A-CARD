import { describe, expect, it } from "vitest";
import { Platform } from "@acard/core";
import { createApp } from "../src/app.js";

const make = (readiness?: () => Promise<void>) => createApp({ platform: new Platform(), issuerWebhookSecret: "s".repeat(32), readiness } as any);

describe("/health/ready", () => {
  it("is ok without a database", async () => {
    const r = await make().request("/health/ready");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).database).toBe("none");
  });
  it("is ok when the database answers", async () => {
    expect((await make(async () => {}).request("/health/ready")).status).toBe(200);
  });
  it("is 503 when the database fails, without leaking the error", async () => {
    const r = await make(async () => { throw new Error("password authentication failed for user x"); }).request("/health/ready");
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("password");
  });
});
