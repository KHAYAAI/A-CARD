import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AcardApiError, AcardClient } from "./client.js";

/**
 * A-CARD MCP server. Exposes the agent-facing card tools over MCP; every tool
 * is a thin call into the REST API, so agents get exactly the same guardrails
 * (limits, rules, human approval) as any other API client.
 */

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(error: unknown) {
  const message =
    error instanceof AcardApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: `Error — ${message}` }], isError: true as const };
}

export function createMcpServer(client: AcardClient): McpServer {
  const server = new McpServer({ name: "acard", version: "0.1.0" });

  server.registerTool(
    "create_card",
    {
      title: "Create virtual card",
      description:
        "Create a virtual card funded from the wallet. Defaults to single-use (closes after first charge). Amounts are integer minor units (cents).",
      inputSchema: {
        label: z.string().optional().describe("Human-readable purpose, e.g. 'flight to Cape Town'"),
        currency: z
          .enum(["ZAR", "USD", "NGN", "KES"])
          .optional()
          .describe("Card currency; draws from the matching wallet (defaults to the org's primary currency)"),
        single_use: z.boolean().optional().describe("Close automatically after first successful charge (default true)"),
        per_transaction_limit: z.number().int().positive().optional().describe("Max cents per charge"),
        total_limit: z.number().int().positive().optional().describe("Lifetime spend cap in cents"),
        allowed_merchant_categories: z.array(z.string()).optional().describe("MCC allow-list; empty = all"),
        approval_threshold: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Charges at or above this many cents require human approval"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const result = await client.createCard({
          label: args.label,
          currency: args.currency,
          single_use: args.single_use,
          limits: {
            per_transaction: args.per_transaction_limit,
            total: args.total_limit,
          },
          allowed_merchant_categories: args.allowed_merchant_categories,
          approval_threshold: args.approval_threshold,
        });
        return ok(result.card);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_card",
    {
      title: "Get card",
      description: "Fetch a card's status, limits, and metadata by id.",
      inputSchema: { card_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ card_id }) => {
      try {
        return ok((await client.getCard(card_id)).card);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_cards",
    {
      title: "List cards",
      description: "List all cards on the account.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok((await client.listCards()).cards);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "pay_checkout",
    {
      title: "Pay a checkout",
      description:
        "Charge a card at a merchant (sandbox simulates the issuer authorization). If the platform requires human approval, the result includes an approval_id — tell the user to approve it, then retry.",
      inputSchema: {
        card_id: z.string(),
        amount: z.number().int().positive().describe("Amount in minor units (cents)"),
        currency: z.enum(["ZAR", "USD", "NGN", "KES"]).default("ZAR"),
        merchant_name: z.string(),
        merchant_category: z.string().default("5999").describe("MCC, e.g. 5411 groceries, 4511 airlines"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (args) => {
      try {
        const result = await client.simulatePurchase({
          card_id: args.card_id,
          amount: args.amount,
          currency: args.currency,
          merchant: { name: args.merchant_name, category: args.merchant_category },
        });
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "close_card",
    {
      title: "Close card",
      description: "Permanently close a card. Closed cards decline all future authorizations.",
      inputSchema: { card_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ card_id }) => {
      try {
        return ok((await client.closeCard(card_id)).card);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description: "List card transactions, optionally filtered to one card.",
      inputSchema: { card_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ card_id }) => {
      try {
        return ok((await client.listTransactions(card_id)).transactions);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_wallet",
    {
      title: "Get wallet balance",
      description:
        "Fetch wallet available/posted/held balances in minor units. Returns every currency wallet the org holds (ZAR, USD, …); pass a currency to focus on one.",
      inputSchema: {
        currency: z.enum(["ZAR", "USD", "NGN", "KES"]).optional().describe("Focus on a single currency wallet"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ currency }) => {
      try {
        const result = await client.wallet(currency);
        return ok(currency ? result.wallet : result.wallets);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "find_offers",
    {
      title: "Find something to buy",
      description:
        "Search A-MERCHANT for real, verified merchants that can supply what you need — by keyword, distance, quantity, budget and delivery deadline. Returns ranked offers with a total price and the reason each ranked where it did, plus why other candidates were excluded. Every offer reports how recently the merchant confirmed its stock: prefer fresh inventory, and treat a stale offer as needing confirmation before you commit. Discovery only — pay for the chosen offer with pay_checkout.",
      inputSchema: {
        query: z.string().optional().describe("What you're looking for, e.g. 'cement 50kg'"),
        merchant_categories: z
          .array(z.string())
          .optional()
          .describe("MCC allow-list — pass the card's allowed_merchant_categories to only find what it can actually pay for"),
        lat: z.number().optional().describe("Latitude to search around"),
        lng: z.number().optional().describe("Longitude to search around"),
        radius_km: z.number().positive().optional().describe("Search radius in km (default 25)"),
        quantity: z.number().int().positive().optional().describe("Units needed; drives total price and the stock check"),
        max_total_cents: z.number().int().positive().optional().describe("Budget ceiling for the whole line, in cents"),
        max_lead_time_days: z.number().int().nonnegative().optional().describe("0 = needed today"),
        max_inventory_age_hours: z
          .number()
          .positive()
          .optional()
          .describe("Reject merchants who have not confirmed stock this recently"),
        currency: z.enum(["ZAR", "USD", "NGN", "KES"]).optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return ok(
          await client.searchMerchants({
            q: args.query,
            categories: args.merchant_categories?.join(","),
            lat: args.lat,
            lng: args.lng,
            radius_km: args.radius_km,
            quantity: args.quantity,
            max_total_cents: args.max_total_cents,
            max_lead_time_days: args.max_lead_time_days,
            max_inventory_age_hours: args.max_inventory_age_hours,
            currency: args.currency,
            limit: args.limit,
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_merchant",
    {
      title: "Get merchant",
      description: "Fetch one merchant's profile and full catalog, including how recently each item's stock was confirmed.",
      inputSchema: { merchant_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ merchant_id }) => {
      try {
        return ok(await client.getMerchant(merchant_id));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
