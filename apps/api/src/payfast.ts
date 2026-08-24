import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";

/**
 * PayFast integration for both real wallet funding and subscription
 * billing (see app.ts's /v1/wallet/fund/checkout and /v1/billing/checkout —
 * both build a signed form via this client and land on the same
 * /webhooks/payfast ITN handler, disambiguated by `custom_str2`).
 *
 * IMPORTANT: PayFast's standard checkout has no currency parameter — the
 * `amount` field bills in whatever currency the merchant account itself is
 * configured for. There is no code-level way to force USD here; if the
 * PayFast account isn't confirmed (with PayFast) as billing in USD, an
 * amount like 2800 (meant as $28.00) will be charged as R28.00 instead.
 * Verify this with PayFast before relying on it for the USD-priced
 * subscription tiers in packages/core/src/billing.ts.
 *
 * Unlike Paystack (a REST
 * "initialize transaction" call that returns a checkout URL), PayFast's
 * checkout is a client-submitted HTML form POST of signed fields to their
 * `/eng/process` endpoint — there's no server-to-server "create a checkout"
 * call. This client's job is to build and sign that field set, and to
 * validate the ITN (Instant Transaction Notification) PayFast posts back.
 *
 * PayFast's ITN validation is stricter than Paystack's single-HMAC check —
 * their own integration guide requires three independent checks before you
 * trust an ITN: (1) the MD5 signature over the posted fields, (2) the
 * request actually originating from a PayFast host, (3) posting the raw
 * body back to PayFast's own validate endpoint and confirming it echoes
 * "VALID". All three are implemented here; skipping any one of them is a
 * documented replay/spoofing risk in PayFast's own docs.
 *
 * The signature scheme signs fields **in the order they were sent**, not
 * alphabetically — this is the one detail most third-party PayFast
 * integrations get wrong. For outgoing checkout fields we control that
 * order (fixed to PayFast's documented field order below). For incoming
 * ITN fields we preserve whatever order they arrived in the raw body.
 */

export interface PayFastConfig {
  merchantId: string;
  merchantKey: string;
  /** Set in the PayFast dashboard; mixed into every signature. Treat like any other webhook secret. */
  passphrase: string;
  /** Sandbox uses sandbox.payfast.co.za and does not move real money. */
  sandbox?: boolean;
}

export interface PayFastCheckoutInput {
  amountMinorUnits: number;
  itemName: string;
  /** Merchant's own reference for this payment (echoed back on the ITN as m_payment_id). */
  reference: string;
  email: string;
  returnUrl: string;
  cancelUrl: string;
  notifyUrl: string;
  /** Passed through untouched on the ITN — used here to carry the account holder id. */
  customStr1?: string;
  /** Passed through untouched on the ITN — used to tag purpose: "fund" (wallet top-up) or "sub:<tier>" (subscription). */
  customStr2?: string;
}

export interface PayFastItn {
  fields: Record<string, string>;
  rawBody: string;
  remoteIp: string;
}

/**
 * The narrow surface app.ts depends on — the real client in production
 * (`createPayFastClient`), a fake implementing this interface in tests.
 * Kept deliberately small, same pattern as `WorkOSClient`/`IssuerCardClient`.
 */
export interface PayFastClient {
  buildCheckout(input: PayFastCheckoutInput): { action: string; fields: Record<string, string> };
  validateItn(itn: PayFastItn): Promise<boolean>;
}

function payfastHost(sandbox: boolean | undefined): string {
  return sandbox ? "sandbox.payfast.co.za" : "www.payfast.co.za";
}

/** MD5 over `key=urlencoded_value&...` joined in insertion order, PayFast's `+`-for-space urlencoding, plus the passphrase if set. */
function signFields(fields: [string, string][], passphrase: string): string {
  const encode = (v: string) => encodeURIComponent(v.trim()).replace(/%20/g, "+");
  const parts = fields.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${encode(v)}`);
  if (passphrase) parts.push(`passphrase=${encode(passphrase)}`);
  return createHash("md5").update(parts.join("&")).digest("hex");
}

/** Exported (alongside the `createPayFastClient` factory) so tests can unit-test signature building without going over the network. */
export class RealPayFastClient implements PayFastClient {
  constructor(private readonly config: PayFastConfig) {}

  /** Builds the signed field set for the client to submit as a form POST to PayFast's process endpoint. Nothing here is a network call. */
  buildCheckout(input: PayFastCheckoutInput): { action: string; fields: Record<string, string> } {
    // Fixed order matches PayFast's documented field ordering for onsite/redirect checkout.
    const ordered: [string, string][] = [
      ["merchant_id", this.config.merchantId],
      ["merchant_key", this.config.merchantKey],
      ["return_url", input.returnUrl],
      ["cancel_url", input.cancelUrl],
      ["notify_url", input.notifyUrl],
      ["email_address", input.email],
      ["m_payment_id", input.reference],
      ["amount", (input.amountMinorUnits / 100).toFixed(2)],
      ["item_name", input.itemName],
      ["custom_str1", input.customStr1 ?? ""],
      ["custom_str2", input.customStr2 ?? ""],
    ];
    const signature = signFields(ordered, this.config.passphrase);
    const fields = Object.fromEntries(ordered.filter(([, v]) => v !== ""));
    fields.signature = signature;
    return { action: `https://${payfastHost(this.config.sandbox)}/eng/process`, fields };
  }

  /** Signature check: recomputes the MD5 over the ITN's own field order (signature field excluded) and compares. */
  verifyItnSignature(itn: PayFastItn): boolean {
    const provided = itn.fields.signature;
    if (!provided) return false;
    const ordered = Object.entries(itn.fields).filter(([k]) => k !== "signature") as [string, string][];
    return signFields(ordered, this.config.passphrase) === provided.toLowerCase();
  }

  /**
   * Best-effort host check: PayFast doesn't publish a stable IP allowlist
   * (their docs recommend resolving their known hostnames and comparing),
   * so this resolves those hostnames at request time rather than trusting a
   * hardcoded IP list that can go stale. Treat a DNS failure as "can't
   * confirm" (false), not as "trusted".
   */
  async isFromPayFast(sourceIp: string): Promise<boolean> {
    const hosts = ["www.payfast.co.za", "sandbox.payfast.co.za", "w1w.payfast.co.za", "w2w.payfast.co.za"];
    for (const host of hosts) {
      try {
        const addrs = await resolve4(host);
        if (addrs.includes(sourceIp)) return true;
      } catch {
        // Unresolvable host — keep checking the others.
      }
    }
    return false;
  }

  /** Server-to-server confirmation: PayFast expects the raw ITN body posted back to their validate endpoint, echoing "VALID". */
  async confirmWithPayFast(rawBody: string): Promise<boolean> {
    const response = await fetch(`https://${payfastHost(this.config.sandbox)}/eng/query/validate`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: rawBody,
    });
    const text = await response.text();
    return text.trim() === "VALID";
  }

  /** Full ITN validation: signature + source host + PayFast's own confirm-back. All three must pass. */
  async validateItn(itn: PayFastItn): Promise<boolean> {
    if (!this.verifyItnSignature(itn)) return false;
    const [sourceOk, confirmOk] = await Promise.all([this.isFromPayFast(itn.remoteIp), this.confirmWithPayFast(itn.rawBody)]);
    return sourceOk && confirmOk;
  }
}

export function createPayFastClient(config: PayFastConfig): PayFastClient {
  return new RealPayFastClient(config);
}
