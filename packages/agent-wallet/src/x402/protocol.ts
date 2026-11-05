/**
 * x402 wire format: reading a 402, building the payment header, reading the
 * settlement. Both versions in the field are spoken:
 *
 *   v2 (github.com/coinbase/x402 `specs/transports-v2/http.md`, checked
 *   October 2026): the server puts a base64 JSON `PaymentRequired` in the
 *   `PAYMENT-REQUIRED` header; the client retries with a base64 JSON
 *   `PaymentPayload` in `PAYMENT-SIGNATURE`, which echoes the chosen
 *   requirement verbatim as `accepted`; the server answers with a base64
 *   JSON `SettlementResponse` in `PAYMENT-RESPONSE`. Networks are CAIP-2
 *   (`eip155:8453`), the price is `amount`.
 *
 *   v1 (still widely deployed): the `PaymentRequired` is the 402's JSON body,
 *   the price is `maxAmountRequired`, networks are names (`base`,
 *   `base-sepolia`), the client header is `X-PAYMENT` and the settlement is
 *   `X-PAYMENT-RESPONSE`.
 *
 * Everything here is pure parsing and encoding — no fetching, no signing —
 * so it's testable byte for byte.
 */

/** USDC is the only asset A-CARD pays x402 in: 6 decimals, so one atomic unit is a millionth of a dollar. */
export const USDC_DECIMALS = 6;

/** The USDC deployments A-CARD will pay with, by CAIP-2 network, with their EIP-712 domain. */
export const USDC_BY_NETWORK: Record<string, { address: string; name: string; version: string }> = {
  "eip155:8453": { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" }, // Base
  "eip155:84532": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" }, // Base Sepolia
};

/** v1 network names → CAIP-2. */
const V1_NETWORKS: Record<string, string> = { base: "eip155:8453", "base-sepolia": "eip155:84532" };

export interface PaymentRequirement {
  scheme: string;
  /** CAIP-2, normalised from v1 names. */
  network: string;
  /** Atomic units of `asset`, as a decimal string. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
  /** Exactly what the server sent for this option. v2 requires the payment to echo it back unchanged. */
  raw: Record<string, unknown>;
}

export interface PaymentRequired {
  version: 1 | 2;
  resource?: Record<string, unknown>;
  accepts: PaymentRequirement[];
  error?: string;
}

export interface SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
}

export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

const decodeBase64Json = (value: string): unknown => JSON.parse(Buffer.from(value, "base64").toString("utf8"));
const encodeBase64Json = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");

function normaliseRequirement(raw: Record<string, unknown>, version: 1 | 2): PaymentRequirement | undefined {
  const network = String(raw.network ?? "");
  const amount = version === 1 ? raw.maxAmountRequired : (raw.amount ?? raw.maxAmountRequired);
  if (typeof raw.scheme !== "string" || typeof raw.payTo !== "string" || typeof raw.asset !== "string") return undefined;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return undefined;
  return {
    scheme: raw.scheme,
    network: V1_NETWORKS[network] ?? network,
    amount,
    asset: raw.asset,
    payTo: raw.payTo,
    maxTimeoutSeconds: Number(raw.maxTimeoutSeconds ?? 60),
    extra: (raw.extra as Record<string, unknown> | undefined) ?? undefined,
    raw,
  };
}

/**
 * Reads a 402 response. Prefers the v2 header; falls back to a v1 (or v2)
 * JSON body. Returns undefined when the response doesn't describe a payment
 * at all — a 402 from something that isn't an x402 server.
 */
export async function readPaymentRequired(response: Response): Promise<PaymentRequired | undefined> {
  let doc: Record<string, unknown> | undefined;
  const header = response.headers.get("payment-required");
  if (header) {
    try {
      doc = decodeBase64Json(header) as Record<string, unknown>;
    } catch {
      doc = undefined;
    }
  }
  if (!doc) {
    doc = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  }
  if (!doc || !Array.isArray(doc.accepts)) return undefined;
  const version = doc.x402Version === 1 ? 1 : 2;
  const accepts = (doc.accepts as Record<string, unknown>[])
    .map((r) => normaliseRequirement(r, version))
    .filter((r): r is PaymentRequirement => r !== undefined);
  return {
    version,
    resource: (doc.resource as Record<string, unknown> | undefined) ?? undefined,
    accepts,
    error: typeof doc.error === "string" ? doc.error : undefined,
  };
}

/**
 * The cheapest option A-CARD can actually pay: the `exact` scheme (an
 * EIP-3009 transfer authorization), in USDC, on a network this deployment
 * allows. Anything else — another scheme, another token, an unknown chain —
 * is skipped rather than guessed at.
 */
export function chooseRequirement(required: PaymentRequired, allowedNetworks: string[]): PaymentRequirement | undefined {
  const payable = required.accepts.filter((r) => {
    const usdc = USDC_BY_NETWORK[r.network];
    return r.scheme === "exact" && allowedNetworks.includes(r.network) && usdc !== undefined && usdc.address.toLowerCase() === r.asset.toLowerCase();
  });
  payable.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0));
  return payable[0];
}

/** The retry header for the version the server spoke. */
export function paymentHeader(
  required: PaymentRequired,
  requirement: PaymentRequirement,
  authorization: TransferAuthorization,
  signature: string,
): { name: string; value: string } {
  if (required.version === 1) {
    return {
      name: "X-PAYMENT",
      value: encodeBase64Json({
        x402Version: 1,
        scheme: requirement.scheme,
        network: requirement.raw.network,
        payload: { signature, authorization },
      }),
    };
  }
  return {
    name: "PAYMENT-SIGNATURE",
    value: encodeBase64Json({
      x402Version: 2,
      ...(required.resource ? { resource: required.resource } : {}),
      accepted: requirement.raw,
      payload: { signature, authorization },
    }),
  };
}

/** The server's settlement report, from whichever header it used. */
export function readSettlement(response: Response): SettlementResponse | undefined {
  const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  if (!header) return undefined;
  try {
    const doc = decodeBase64Json(header) as Record<string, unknown>;
    return {
      success: doc.success === true,
      transaction: typeof doc.transaction === "string" ? doc.transaction : undefined,
      network: typeof doc.network === "string" ? doc.network : undefined,
      payer: typeof doc.payer === "string" ? doc.payer : undefined,
      errorReason: typeof doc.errorReason === "string" ? doc.errorReason : undefined,
    };
  } catch {
    return undefined;
  }
}

/** "0.05" → 50000n (USDC atomic units). Throws on anything that isn't a plain non-negative decimal. */
export function usdToAtomic(usd: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!match) throw new Error(`not a dollar amount: ${usd}`);
  return BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0") || "0");
}

/** 50000n → "0.050000" */
export function atomicToUsd(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

/** USDC atomic units per cent. */
export const ATOMIC_PER_CENT = 10_000n;
