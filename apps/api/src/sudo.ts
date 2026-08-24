/**
 * Thin client for Sudo Africa (or any BIN-sponsored card issuer with a
 * broadly similar REST shape) — the actual "issue a real card" step behind
 * the sandbox's mock issuer.
 *
 * ⚠️ THE WIRE FORMAT BELOW IS UNVERIFIED. Everything else in this codebase's
 * issuer integrations (Stripe, WorkOS) was built against a real SDK's type
 * declarations or a live API call — this repo has no Sudo API documentation,
 * Postman collection, or sandbox credentials attached to it, so the request
 * path, request body, and response field names in `createCard` below are
 * placeholders, not a verified contract. They are deliberately isolated to
 * the two methods below so that correcting them against Sudo's actual docs
 * is a small, contained edit — not a rewrite of the integration.
 *
 * What IS real and does not depend on Sudo's exact wire format:
 *   - the `IssuerCardClient` interface (so app.ts and tests depend on a
 *     shape, not this implementation)
 *   - `packages/core`'s `issuerCardId` linking (Card.issuerCardId,
 *     Platform.getCardByIssuerCardId / linkIssuerCard) and the matching
 *     Postgres columns/index/migration — a card is resolvable by Sudo's own
 *     reference the moment `createCard` returns one, regardless of exactly
 *     what JSON shape that reference arrived in.
 *   - the webhook authorization path resolving a card by `id` OR
 *     `issuer_card_id` in one query — so once Sudo's real payload shape is
 *     confirmed, only the field name(s) below need to change.
 *
 * To finish this integration for real: get Sudo's sandbox API reference
 * (base URL, the card-creation endpoint's request/response schema, and
 * their webhook's authorization-event schema + signature scheme) and update
 * `createCard` and the webhook mapping in app.ts accordingly.
 */

export interface SudoConfig {
  baseUrl: string;
  apiKey: string;
  /** Sudo's own webhook signing secret, if different from A-CARD's HMAC scheme. Unconfirmed — see file header. */
  webhookSecret?: string;
}

export interface ProvisionedIssuerCard {
  /** Sudo's own reference for the card — never a PAN. Stored as Card.issuerCardId. */
  issuerCardId: string;
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
}

/** Narrow surface app.ts depends on, so tests inject a fake instead of hitting the network — same pattern as WorkOSClient. */
export interface IssuerCardClient {
  createCard(input: { accountHolderId: string; cardId: string; currency: string }): Promise<ProvisionedIssuerCard>;
}

export function createSudoClient(config: SudoConfig): IssuerCardClient {
  return {
    async createCard(input) {
      // --- UNVERIFIED WIRE FORMAT (see file header) ---------------------------
      const response = await fetch(`${config.baseUrl}/cards`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          customer_reference: input.accountHolderId,
          external_reference: input.cardId,
          currency: input.currency,
        }),
      });
      if (!response.ok) {
        throw new Error(`Sudo card creation failed: ${response.status} ${await response.text()}`);
      }
      const body = (await response.json()) as {
        id: string;
        last4?: string;
        expiry_month?: number;
        expiry_year?: number;
      };
      return {
        issuerCardId: body.id,
        last4: body.last4,
        expiryMonth: body.expiry_month,
        expiryYear: body.expiry_year,
      };
      // -------------------------------------------------------------------------
    },
  };
}
