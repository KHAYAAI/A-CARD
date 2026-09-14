import { signWebhook, type Merchant } from "@acard/core";

/**
 * Pushing events out to a merchant's own system.
 *
 * The merchant API (`/v1/merchant-api/*`) lets a POS pull. That is the wrong
 * shape for the event that matters most: an order arriving. A till that has
 * to poll finds out late, and "late" for a construction supplier means the
 * agent already bought elsewhere. So orders are pushed.
 *
 * Signed with the exact same HMAC scheme as A-CARD's own issuer webhook
 * (`t=…,v1=…` over `timestamp.body`), deliberately — a merchant integrating
 * both verifies them with one piece of code, and we are not inventing a
 * second signing format for the same job.
 *
 * ## What this is not
 *
 * Not a durable queue. Delivery is attempted once, with a short timeout, and
 * the outcome is recorded on the merchant so a dead endpoint is *visible*
 * rather than silent. A merchant whose endpoint was down does not lose the
 * order — it is still in `/v1/merchant-api/orders`, and there is an explicit
 * redelivery endpoint. Building a real retry queue before a single POS
 * partner has integrated would be guessing at requirements; making failure
 * visible and recoverable is the honest amount of machinery for today.
 */

export interface MerchantWebhookEvent {
  /** e.g. `order.placed`, `order.cancelled`, `purchase.reported`. */
  type: string;
  merchantId: string;
  data: Record<string, unknown>;
}

export interface DeliveryResult {
  delivered: boolean;
  status?: number;
  error?: string;
  /** What was sent, so a redelivery sends byte-identical content. */
  body: string;
}

export interface MerchantWebhookDeps {
  fetchImpl?: typeof fetch;
  /** Milliseconds before a slow endpoint is abandoned. */
  timeoutMs?: number;
}

/**
 * Deliver one event to one merchant's endpoint.
 *
 * Never throws. A merchant's endpoint being broken is their operational
 * problem, not an exception that should propagate into an agent's order
 * request — the order is already recorded either way.
 */
export async function deliverMerchantWebhook(
  merchant: Merchant,
  event: MerchantWebhookEvent,
  secret: string,
  deps: MerchantWebhookDeps = {},
): Promise<DeliveryResult> {
  const body = JSON.stringify({
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    type: event.type,
    created_at: new Date().toISOString(),
    merchant_id: event.merchantId,
    data: event.data,
  });

  if (!merchant.webhook) return { delivered: false, error: "no webhook registered", body };
  if (merchant.webhook.events.length > 0 && !merchant.webhook.events.includes(event.type)) {
    return { delivered: false, error: `merchant is not subscribed to ${event.type}`, body };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000);
  try {
    const res = await doFetch(merchant.webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acard-signature": signWebhook(body, secret),
        "x-acard-event": event.type,
      },
      body,
      signal: controller.signal,
    });
    return { delivered: res.ok, status: res.status, body, error: res.ok ? undefined : `endpoint returned ${res.status}` };
  } catch (error) {
    return { delivered: false, body, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
