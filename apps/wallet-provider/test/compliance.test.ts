import { describe, expect, it } from "vitest";
import { loadMasterKey } from "../src/kms.js";
import { mainnetReadiness } from "../src/readiness.js";
import { checkTransfer, DiditScreener } from "../src/screening.js";

const HEX = "a1".repeat(16) + "b2".repeat(16);
const fakeKms = (plain: Buffer, seen: string[] = []) => () => ({ async decrypt(ct: Buffer, id: string) { seen.push(`${id}:${ct.toString()}`); return Buffer.from(plain); } });

describe("master key custody", () => {
  it("decrypts the master key through KMS", async () => {
    const seen: string[] = [];
    const r = await loadMasterKey({ PROVIDER_MASTER_KEY_KMS_CIPHERTEXT: Buffer.from("blob").toString("base64"), PROVIDER_KMS_KEY_ID: "alias/acard" }, fakeKms(Buffer.from(HEX, "hex"), seen));
    expect(r.source).toBe("aws-kms");
    expect(r.key.toString("hex")).toBe(HEX);
    expect(seen).toEqual(["alias/acard:blob"]);
  });
  it("refuses both at once, a missing key id, and a weak KMS key", async () => {
    await expect(loadMasterKey({ PROVIDER_MASTER_KEY: HEX, PROVIDER_MASTER_KEY_KMS_CIPHERTEXT: "eA==", PROVIDER_KMS_KEY_ID: "k" })).rejects.toThrow(/not both/);
    await expect(loadMasterKey({ PROVIDER_MASTER_KEY_KMS_CIPHERTEXT: "eA==" })).rejects.toThrow(/KMS_KEY_ID/);
    await expect(loadMasterKey({ PROVIDER_MASTER_KEY_KMS_CIPHERTEXT: "eA==", PROVIDER_KMS_KEY_ID: "k" }, fakeKms(Buffer.alloc(32)))).rejects.toThrow();
  });
  it("still accepts a plain key, labelled as such", async () => {
    expect((await loadMasterKey({ PROVIDER_MASTER_KEY: HEX })).source).toBe("env");
  });
});

const screener = (r: object | Error) => ({ name: "t", async screen() { if (r instanceof Error) throw r; return r as any; } });

describe("screening and Travel Rule", () => {
  it("blocks sanctioned and high-risk destinations, allows low", async () => {
    await expect(checkTransfer({ screener: screener({ sanctionsHit: true, severity: "low" }) }, "ethereum", "0x1", 1n)).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(checkTransfer({ screener: screener({ sanctionsHit: false, severity: "high" }) }, "ethereum", "0x1", 1n)).rejects.toMatchObject({ code: "destination_blocked" });
    expect((await checkTransfer({ screener: screener({ sanctionsHit: false, severity: "unknown" }) }, "ethereum", "0x1", 1n)).screening?.severity).toBe("unknown");
    await expect(checkTransfer({ blockUnknown: true, screener: screener({ sanctionsHit: false, severity: "unknown" }) }, "ethereum", "0x1", 1n)).rejects.toMatchObject({ code: "destination_blocked" });
    expect((await checkTransfer({ screener: screener({ sanctionsHit: false, severity: "low" }) }, "ethereum", "0x1", 1n)).screening?.by).toBe("t");
  });
  it("fails closed when screening is down", async () => {
    await expect(checkTransfer({ screener: screener(new Error("timeout")) }, "ethereum", "0x1", 1n)).rejects.toMatchObject({ code: "screening_unavailable", status: 503 });
  });
  it("needs originator and beneficiary at or above the threshold", async () => {
    const cfg = { travelRuleThreshold: 1000_000_000n };
    expect((await checkTransfer(cfg, "ethereum", "0x1", 999_999_999n)).travelRule).toBe(false);
    await expect(checkTransfer(cfg, "ethereum", "0x1", 1000_000_000n)).rejects.toMatchObject({ code: "travel_rule_required" });
    await expect(checkTransfer(cfg, "ethereum", "0x1", 1000_000_000n, { originatorName: "A", beneficiaryName: "Bob" })).rejects.toMatchObject({ code: "travel_rule_required" });
    expect((await checkTransfer(cfg, "ethereum", "0x1", 1000_000_000n, { originatorName: "Ann", beneficiaryName: "Bob" })).travelRule).toBe(true);
  });
  it("treats an unscreened result as an outage", async () => {
    const s = new DiditScreener("k", "https://d.test", (async () => new Response(JSON.stringify({ status: "PENDING" }))) as any);
    await expect(checkTransfer({ screener: s }, "ethereum", "0x1", 1n)).rejects.toMatchObject({ code: "screening_unavailable" });
  });
  it("calls Didit's screen-wallet endpoint", async () => {
    let call: any;
    const s = new DiditScreener("k", "https://d.test", (async (url: string, init: any) => { call = { url, init }; return new Response(JSON.stringify({ sanctions_hit: false, severity: "Low", risk_score: 3 })); }) as any);
    expect(await s.screen("0xabc", "ethereum")).toEqual({ sanctionsHit: false, severity: "low", riskScore: 3 });
    expect(call.url).toBe("https://d.test/v2/transactions/screen-wallet/");
    expect(call.init.headers["x-api-key"]).toBe("k");
    expect(JSON.parse(call.init.body)).toMatchObject({ wallet_address: "0xabc", blockchain: "ETH", direction: "outbound" });
  });
});

describe("mainnet gate", () => {
  it("lists everything missing, and passes only with all of it", () => {
    expect(mainnetReadiness({ env: {}, keySource: "env", screening: false, travelRule: false, storeIsFile: false })).toHaveLength(8);
    expect(mainnetReadiness({ env: { PROVIDER_AUDIT_REF: "AUD-2027-01", PROVIDER_LICENCE_REF: "FSCA-12345", PROVIDER_RAMP_PARTNER_REF: "RAMP-MSA-1" }, signer: "aws-kms", keySource: "none", screening: true, travelRule: true, storeIsFile: true })).toEqual([]);
  });
});
