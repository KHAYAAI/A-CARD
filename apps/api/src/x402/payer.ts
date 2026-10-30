import { randomUUID } from "node:crypto";
import { createIntent, newId, type AfpTransaction, type Card } from "@acard/core";
import type { AfpLedgerPort } from "../afp/types.js";
import type { PlatformService } from "../service/types.js";
import { assertFetchableUrl, UnsafeUrlError } from "./guard.js";
import {
  ATOMIC_PER_CENT,
  atomicToUsd,
  chooseRequirement,
  paymentHeader,
  readPaymentRequired,
  readSettlement,
  type PaymentRequirement,
  type SettlementResponse,
} from "./protocol.js";
import { newNonce, type X402Signer } from "./signer.js";

/**
 * x402 under A-CARD's controls.
 *
 * An agent asks to fetch a URL that charges over x402. Before a single
 * signature exists, the payment goes through the same `authorize` every card
 * charge does — the card's merchant-category allow-list (it must allow
 * `x402`), its per-transaction, total and velocity limits, its approval
 * threshold, the org's blocked categories and approval threshold, the
 * department's monthly budget, and the wallet balance. Plus two checks only
 * x402 needs: the card's `x402AllowedHosts`, and the agent's own `max_usd`,
 * so a server can't quote more than the agent expected to pay.
 *
 * **Paying less than a cent.** x402 prices are often fractions of a cent;
 * A-CARD's ledger counts whole cents. Each card keeps a tab: the exact USDC
 * it has paid over x402 (atomic units, millionths of a dollar) and the whole
 * cents A-CARD has charged the card for it. A payment only authorizes the
 * cents the tab is about to cross — so ten $0.001 calls are one 1-cent charge,
 * and a $2.50 call is a 250-cent charge with all the usual rules. The card is
 * never charged less than it has paid, and at most one cent ahead of it; that
 * cent is credit the next payment uses first.
 *
 * **Order of operations** (the same discipline as AFP's ledger):
 *   1. card checks that need no network: category, hosts
 *   2. fetch unpaid; a 2xx is free, a 402 is the price
 *   3. price checks: payable option, agent's cap, card's per-transaction limit
 *   4. authorize the cents the tab needs (a hold — this is where limits,
 *      approvals and balance are enforced; held for approval → stop here)
 *   5. record the pending AFP transaction (before any signature exists)
 *   6. sign, retry with the payment header
 *   7. paid → capture the hold, settle the transaction;
 *      refused → release the hold, fail the transaction;
 *      unknown (dropped connection, 5xx) → keep the hold, park it reconciling
 */

export interface X402PayerConfig {
  signer: X402Signer;
  /** The address paying; must be the one `signer` controls. */
  payerAddress: string;
  /** CAIP-2 networks this deployment pays on, e.g. ["eip155:84532"]. */
  networks: string[];
  /** Sandbox/tests only: allow plain-HTTP and private-network URLs. */
  allowPrivateNetworks?: boolean;
  fetchImpl?: typeof fetch;
  /** Cap on resource bytes read and returned. Default 256 KiB. */
  maxResponseBytes?: number;
  timeoutMs?: number;
}

export interface X402PayRequest {
  holderId: string;
  cardId: string;
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** The most the agent agreed to pay, USDC atomic units. */
  maxAtomic: bigint;
  idempotencyKey: string;
}

export interface X402Resource {
  status: number;
  contentType?: string;
  bytes: number;
  body?: string;
  truncated?: boolean;
}

export type X402Status = "paid" | "free" | "held" | "declined" | "failed" | "reconciling";

export interface X402Outcome {
  status: X402Status;
  declineReason?: string;
  approvalId?: string;
  message?: string;
  price?: { amountAtomic: string; usd: string; network: string; asset: string; payTo: string };
  chargedCents?: number;
  tab?: X402Tab;
  transaction?: AfpTransaction;
  settlement?: SettlementResponse;
  resource?: X402Resource;
  replayed?: boolean;
}

export interface X402Tab {
  cardId: string;
  payments: number;
  paidAtomic: string;
  paidUsd: string;
  chargedCents: number;
  creditAtomic: string;
}

export class X402RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 422 | 502 = 400,
  ) {
    super(message);
  }
}

export const X402_FINALITY = { kind: "instant" } as const;
export const X402_CATEGORY = "x402";

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]*\+json|[^;]*\+xml)/i;

function hostAllowed(card: Card, host: string): boolean {
  const allowed = card.x402AllowedHosts;
  if (!allowed?.length) return true;
  const h = host.toLowerCase();
  // An entry matches the host itself and, written as ".example.com", any subdomain.
  return allowed.some((entry) => (entry.startsWith(".") ? h.endsWith(entry) || h === entry.slice(1) : h === entry));
}

export function createX402Payer(platform: PlatformService, ledger: AfpLedgerPort, config: X402PayerConfig) {
  const doFetch = config.fetchImpl ?? fetch;
  const maxBytes = config.maxResponseBytes ?? 256 * 1024;
  const timeoutMs = config.timeoutMs ?? 30_000;
  /** One payment per card at a time, so two concurrent payments can't both spend the same tab credit. */
  const cardLocks = new Map<string, Promise<unknown>>();

  const withCardLock = async <T>(cardId: string, fn: () => Promise<T>): Promise<T> => {
    const previous = cardLocks.get(cardId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    cardLocks.set(cardId, run);
    try {
      return await run;
    } finally {
      if (cardLocks.get(cardId) === run) cardLocks.delete(cardId);
    }
  };

  async function readResource(response: Response): Promise<X402Resource> {
    const contentType = response.headers.get("content-type") ?? undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    const kept = buffer.subarray(0, maxBytes);
    return {
      status: response.status,
      contentType,
      bytes: buffer.length,
      body: contentType && TEXTUAL.test(contentType) ? kept.toString("utf8") : undefined,
      truncated: buffer.length > maxBytes || undefined,
    };
  }

  async function tab(holderId: string, cardId: string): Promise<X402Tab> {
    const txs = (await ledger.list(holderId)).filter(
      (t) => t.rail === "x402" && t.metadata?.cardId === cardId && t.status !== "failed",
    );
    let paid = 0n;
    let charged = 0;
    for (const t of txs) {
      paid += BigInt(String(t.metadata?.priceAtomic ?? "0"));
      charged += Number(t.metadata?.chargedCents ?? 0);
    }
    return {
      cardId,
      payments: txs.length,
      paidAtomic: paid.toString(),
      paidUsd: atomicToUsd(paid),
      chargedCents: charged,
      creditAtomic: (BigInt(charged) * ATOMIC_PER_CENT - paid).toString(),
    };
  }

  const request = (url: URL, req: X402PayRequest, extraHeaders: Record<string, string> = {}) =>
    doFetch(url, {
      method: req.method ?? "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.5", ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...extraHeaders },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });

  function replay(tx: AfpTransaction): X402Outcome {
    const status: X402Status =
      tx.status === "settled" ? "paid" : tx.status === "failed" ? "failed" : tx.status === "reconciling" ? "reconciling" : "reconciling";
    return {
      status,
      replayed: true,
      transaction: tx,
      chargedCents: Number(tx.metadata?.chargedCents ?? 0),
      price: tx.metadata?.priceAtomic
        ? {
            amountAtomic: String(tx.metadata.priceAtomic),
            usd: atomicToUsd(BigInt(String(tx.metadata.priceAtomic))),
            network: String(tx.metadata.network),
            asset: String(tx.metadata.asset),
            payTo: String(tx.metadata.payTo),
          }
        : undefined,
      message: "This Idempotency-Key was already used; this is the recorded outcome. The resource body is not replayed.",
    };
  }

  async function pay(req: X402PayRequest): Promise<X402Outcome> {
    // Scoped per org: a key is only ever a lookup within the caller's own account.
    const idempotencyKey = `x402:${req.holderId}:${req.idempotencyKey}`;
    const existing = await ledger.getByIdempotencyKey(idempotencyKey);
    if (existing) return replay(existing);

    const card = await platform.getCard(req.cardId);
    if (!card || card.accountHolderId !== req.holderId) throw new X402RequestError("not_found", "card not found", 404);

    let url: URL;
    try {
      url = await assertFetchableUrl(req.url, { allowPrivateNetworks: config.allowPrivateNetworks });
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new X402RequestError("x402_url_not_allowed", error.message, 422);
      throw error;
    }
    const host = url.hostname.toLowerCase();

    // 1. Card checks that need no network — refuse before contacting a host this card may not pay.
    if (card.status !== "active") return { status: "declined", declineReason: "card_closed" };
    if (card.allowedMerchantCategories.length > 0 && !card.allowedMerchantCategories.includes(X402_CATEGORY)) {
      return { status: "declined", declineReason: "merchant_category_not_allowed", message: `this card's categories don't include "${X402_CATEGORY}"` };
    }
    if (!hostAllowed(card, host)) {
      return { status: "declined", declineReason: "x402_host_not_allowed", message: `${host} is not in this card's x402 allowed hosts` };
    }

    // 2. Ask, unpaid.
    let first: Response;
    try {
      first = await request(url, req);
    } catch (error) {
      throw new X402RequestError("x402_resource_unreachable", `could not reach ${url.origin}: ${error instanceof Error ? error.message : error}`, 502);
    }
    if (first.status >= 200 && first.status < 300) return { status: "free", resource: await readResource(first) };
    if (first.status !== 402) {
      throw new X402RequestError("x402_unexpected_status", `${url.origin} answered ${first.status} without asking for payment`, 502);
    }
    const required = await readPaymentRequired(first);
    if (!required) throw new X402RequestError("x402_invalid_payment_required", `${url.origin} answered 402 without an x402 payment description`, 502);

    // 3. Price checks.
    const requirement = chooseRequirement(required, config.networks);
    if (!requirement) {
      return {
        status: "declined",
        declineReason: "x402_no_supported_payment_option",
        message: `none of the ${required.accepts.length} payment option(s) is USDC "exact" on ${config.networks.join(", ")}`,
      };
    }
    const priceAtomic = BigInt(requirement.amount);
    const price = { amountAtomic: requirement.amount, usd: atomicToUsd(priceAtomic), network: requirement.network, asset: requirement.asset, payTo: requirement.payTo };
    if (priceAtomic > req.maxAtomic) {
      return { status: "declined", declineReason: "x402_price_above_max", price, message: `price ${price.usd} USD is above your max ${atomicToUsd(req.maxAtomic)} USD` };
    }
    if (card.limits.perTransaction !== undefined && priceAtomic > BigInt(card.limits.perTransaction) * ATOMIC_PER_CENT) {
      return { status: "declined", declineReason: "per_transaction_limit_exceeded", price };
    }

    return withCardLock(card.id, async () => {
      // 4. Authorize the cents the tab is about to cross.
      const before = await tab(req.holderId, card.id);
      const paidAfter = BigInt(before.paidAtomic) + priceAtomic;
      const centsAfter = Number((paidAfter + ATOMIC_PER_CENT - 1n) / ATOMIC_PER_CENT);
      const needed = Math.max(0, centsAfter - before.chargedCents);
      const authorizationId = needed > 0 ? `x402auth_${randomUUID()}` : undefined;
      if (authorizationId) {
        const decision = await platform.authorize({
          authorizationId,
          cardId: card.id,
          amount: needed,
          currency: "USD",
          merchant: { name: `x402 · ${host}`, category: X402_CATEGORY },
        });
        if (!decision.approved) {
          const held = decision.declineReason === "pending_human_approval";
          return {
            status: held ? "held" : "declined",
            declineReason: decision.declineReason,
            approvalId: decision.approvalId,
            price,
            tab: before,
            message: held ? "a person must approve this in A-CARD; once approved, retry the same call with a new Idempotency-Key" : undefined,
          } satisfies X402Outcome;
        }
      }

      // 5. The pending record exists before any signature does.
      const intent = createIntent({
        accountHolderId: req.holderId,
        amount: Math.max(1, Number((priceAtomic + ATOMIC_PER_CENT - 1n) / ATOMIC_PER_CENT)),
        currency: "USD",
        purpose: `x402 ${req.method ?? "GET"} ${url.origin}${url.pathname}`,
        counterparty: url.toString(),
        allowedRails: ["x402"],
      });
      await ledger.recordIntent(intent);
      const tx = await ledger.beginExecution(intent, "x402", X402_FINALITY, idempotencyKey, {
        cardId: card.id,
        host,
        url: url.toString(),
        method: req.method ?? "GET",
        protocolVersion: required.version,
        network: requirement.network,
        asset: requirement.asset,
        payTo: requirement.payTo,
        priceAtomic: requirement.amount,
        chargedCents: needed,
        authorizationId,
      });
      if (tx.metadata?.authorizationId !== authorizationId) {
        // Lost a race on the same Idempotency-Key: the other request owns the payment. Release ours.
        if (authorizationId) await platform.reverse(authorizationId).catch(() => {});
        return replay(tx);
      }

      const releaseHold = async () => {
        if (authorizationId) await platform.reverse(authorizationId).catch(() => {});
      };

      // 6. Sign and retry.
      const now = Math.floor(Date.now() / 1000);
      const authorization = {
        from: config.payerAddress,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: String(now - 60),
        validBefore: String(now + Math.max(30, requirement.maxTimeoutSeconds)),
        nonce: newNonce(),
      };
      let signature: string;
      try {
        ({ signature } = await config.signer.sign({ requirement: requirement as PaymentRequirement, ...authorization }));
      } catch (error) {
        await releaseHold();
        const failed = await ledger.markFailed(tx.id, `signing failed: ${error instanceof Error ? error.message : error}`);
        return { status: "failed", declineReason: "x402_signing_failed", price, transaction: failed };
      }
      const header = paymentHeader(required, requirement, authorization, signature);

      let paid: Response;
      try {
        paid = await request(url, req, { [header.name]: header.value });
      } catch (error) {
        // The payment may or may not have reached the server. Keep the hold; a person or the reconciler decides.
        const parked = await ledger.markReconciling(tx.id, `retry failed mid-flight: ${error instanceof Error ? error.message : error}`);
        return { status: "reconciling", price, chargedCents: needed, transaction: parked, message: "outcome unknown: the hold stays until this is reconciled" };
      }

      // 7. Outcome.
      const settlement = readSettlement(paid);
      if (paid.status >= 200 && paid.status < 300) {
        if (authorizationId) await platform.capture(authorizationId);
        const completed = await ledger.completeExecution(tx.id, { railReference: settlement?.transaction || newId("x402tx"), immediate: true });
        return {
          status: "paid",
          price,
          chargedCents: needed,
          settlement,
          transaction: completed,
          tab: await tab(req.holderId, card.id),
          resource: await readResource(paid),
        };
      }
      if (paid.status >= 500 || settlement?.transaction) {
        // A server error after receiving a signed payment, or a settlement that broadcast but didn't confirm: unknown, not failed.
        const parked = await ledger.markReconciling(tx.id, `server answered ${paid.status}${settlement?.errorReason ? ` (${settlement.errorReason})` : ""}`);
        return { status: "reconciling", price, chargedCents: needed, settlement, transaction: parked };
      }
      await releaseHold();
      const failed = await ledger.markFailed(tx.id, `payment refused with ${paid.status}${settlement?.errorReason ? `: ${settlement.errorReason}` : ""}`);
      return {
        status: "failed",
        declineReason: "x402_payment_rejected",
        message: settlement?.errorReason ?? `the server refused the payment (${paid.status})`,
        price,
        settlement,
        transaction: failed,
      };
    });
  }

  return {
    pay,
    tab,
    get carriesRealValue() {
      return config.signer.isSandbox !== true;
    },
  };
}

export type X402Payer = ReturnType<typeof createX402Payer>;
