import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { Acard, AcardError } from "@acard/sdk";
import { money, resolveOptions, runIfMain, type ExampleOptions } from "./lib.js";

/**
 * A fleet agent powered by Claude that buys fuel with an A-CARD card.
 *
 * Claude decides what to do; A-CARD decides what it is *allowed* to do. The
 * card behind these tools only works at fuel and service stations, caps each
 * fill and the day's spend, and every refusal comes back as a reason code
 * Claude can read and explain — so the interesting part of this example is
 * watching a model work *inside* limits it cannot talk its way past.
 *
 *   npx tsx seed-demo-world.ts                       # prints a key and the fleet card id
 *   ACARD_API_KEY=ak_… FLEET_CARD_ID=card_… \
 *   ANTHROPIC_API_KEY=sk-ant-… npx tsx 02-claude-fuel-agent.ts
 *
 * Uses the Anthropic TypeScript SDK's tool runner: each tool below is an
 * A-CARD SDK call, and the runner drives the loop.
 */

export const DEFAULT_TASK =
  "Truck 14 (Germiston depot, -26.2309, 28.1772) needs 180 litres of diesel before its 06:00 run, " +
  "and Truck 9 needs 300 litres. Find fuel nearby and pay for what you're allowed to. " +
  "Report what you bought and anything you couldn't.";

const SYSTEM = [
  "You are fleet-agent-07, buying fuel for Khaya Logistics' trucks with one company card.",
  "Use find_fuel to locate fuel, check_card to see your card's limits, and pay_for_fuel to pay.",
  "Every payment is checked by A-CARD against the card's rules. If a payment is declined, read the decline_reason and act on it:",
  "never split a purchase to get under a per-transaction limit, never try another merchant category, and never retry a decline unchanged.",
  "If a purchase needs a human (pending_human_approval) or exceeds your limits, stop and say clearly what a human needs to do.",
  "Amounts are integer cents (ZAR). End with a short report: what was bought, for how much, and what still needs a human.",
].join("\n");

/** The A-CARD-backed tools. Exported so they can be exercised without calling Claude. */
export function fleetTools(acard: Acard, cardId: string) {
  const asResult = (value: unknown) => JSON.stringify(value);
  const asError = (error: unknown) =>
    JSON.stringify(error instanceof AcardError ? { error: error.code, message: error.message } : { error: String(error) });

  return [
    betaZodTool({
      name: "check_card",
      description: "Show this agent's card: status, per-transaction limit, total budget, velocity window and allowed merchant categories (MCC).",
      inputSchema: z.object({}),
      run: async () => {
        try {
          const card = await acard.cards.get(cardId);
          return asResult({ status: card.status, limits: card.limits, allowedMerchantCategories: card.allowedMerchantCategories, currency: card.currency });
        } catch (error) {
          return asError(error);
        }
      },
    }),
    betaZodTool({
      name: "find_fuel",
      description: "Find verified fuel suppliers near a point. Returns ranked offers with price per litre, total, distance and how fresh the stock data is.",
      inputSchema: z.object({
        litres: z.number().int().positive().describe("Litres needed"),
        lat: z.number(),
        lng: z.number(),
        radius_km: z.number().positive().default(40),
      }),
      run: async ({ litres, lat, lng, radius_km }) => {
        try {
          const { offers, excluded } = await acard.merchants.search({ q: "diesel", quantity: litres, lat, lng, radius_km, categories: ["5541", "5542"] });
          return asResult({
            offers: offers.map((o) => ({
              merchant: o.merchant.name,
              merchant_category: o.merchant.merchantCategoryCode,
              price_per_litre_cents: o.unitPriceCents,
              total_cents: o.totalCents,
              distance_km: o.distanceKm,
              freshness: o.freshness,
            })),
            excluded: excluded.map((e) => e.reason),
          });
        } catch (error) {
          return asError(error);
        }
      },
    }),
    betaZodTool({
      name: "pay_for_fuel",
      description:
        "Pay a fuel merchant with the agent's card. Returns approved true/false and, when declined, a decline_reason. A decline is final for that exact charge.",
      inputSchema: z.object({
        merchant_name: z.string(),
        merchant_category: z.string().describe("The merchant's MCC from find_fuel, e.g. 5541"),
        amount_cents: z.number().int().positive(),
      }),
      run: async ({ merchant_name, merchant_category, amount_cents }) => {
        try {
          const result = await acard.sandbox.purchase({
            card_id: cardId,
            amount: amount_cents,
            merchant: { name: merchant_name, category: merchant_category },
          });
          return asResult({
            approved: result.approved,
            decline_reason: result.decline_reason,
            approval_id: result.approval_id,
            wallet_available_cents: result.wallet.available,
          });
        } catch (error) {
          return asError(error);
        }
      },
    }),
  ];
}

export async function runFleetAgent(options: ExampleOptions & { cardId?: string; task?: string } = {}) {
  const { baseUrl, apiKey, log } = resolveOptions(options);
  const cardId = options.cardId ?? process.env.FLEET_CARD_ID;
  if (!apiKey || !cardId) throw new Error("Set ACARD_API_KEY and FLEET_CARD_ID (run seed-demo-world.ts to get both).");

  const acard = new Acard({ apiKey, baseUrl });
  const client = new Anthropic(); // ANTHROPIC_API_KEY, or an `ant auth login` profile

  const runner = client.beta.messages.toolRunner({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // Server-side fallback: if the model declines on a safety classifier, the API
    // reroutes the request inside the same call rather than returning a refusal.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    tools: fleetTools(acard, cardId),
    messages: [{ role: "user", content: options.task ?? DEFAULT_TASK }],
  });

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "tool_use") log(`→ ${block.name} ${JSON.stringify(block.input)}`);
    }
  }
  const final = await runner.done();
  if (final.stop_reason === "refusal") {
    log(`Claude declined this request (${final.stop_details?.category ?? "no category"}).`);
    return final;
  }
  for (const block of final.content) if (block.type === "text") log(block.text);

  const wallet = await acard.wallet.get("ZAR");
  log(`Wallet available afterwards: ${money(wallet.available)}`);
  return final;
}

runIfMain(import.meta.url, () => runFleetAgent());
