#!/usr/bin/env node
import { Command } from "commander";
import * as p from "@clack/prompts";
import { loadConfig, saveConfig } from "./config.js";

const program = new Command();

program.name("acard").description("A-CARD — virtual cards for AI agents (ZAR-first)").version("0.1.0");

function formatCents(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = loadConfig();
  if (!config.apiKey && path !== "/v1/signup") {
    p.log.error("Not signed in. Run `acard signup` first.");
    process.exit(1);
  }
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as any;
  if (!response.ok) {
    p.log.error(body?.error?.message ?? `request failed (${response.status})`);
    process.exit(1);
  }
  return body as T;
}

program
  .command("signup")
  .description("Create an account and store an API key locally")
  .action(async () => {
    p.intro("A-CARD signup");
    const email = await p.text({ message: "Email", validate: (v) => (v.includes("@") ? undefined : "enter a valid email") });
    if (p.isCancel(email)) return p.cancel("cancelled");
    const name = await p.text({ message: "Name" });
    if (p.isCancel(name)) return p.cancel("cancelled");
    const currency = await p.select({
      message: "Wallet currency",
      options: [
        { value: "ZAR", label: "ZAR — South African Rand" },
        { value: "USD", label: "USD — US Dollar" },
        { value: "NGN", label: "NGN — Nigerian Naira" },
        { value: "KES", label: "KES — Kenyan Shilling" },
      ],
    });
    if (p.isCancel(currency)) return p.cancel("cancelled");

    const spinner = p.spinner();
    spinner.start("Creating account");
    const result = await api<{ api_key: string; account_holder: { email: string } }>("/v1/signup", {
      method: "POST",
      body: JSON.stringify({ email, name, currency }),
    });
    spinner.stop("Account created");

    const config = loadConfig();
    saveConfig({ ...config, apiKey: result.api_key, email: result.account_holder.email });
    p.note(`API key saved to ~/.acard/config.json\n\nFor MCP clients:\n  ACARD_API_KEY=${result.api_key}`, "Credentials");
    p.outro("You're in. Try `acard fund 50000` then `acard create-card`.");
  });

  program
  .command("fund <amount>")
  .description("Fund a wallet (sandbox), amount in minor units (cents)")
  .option("--currency <ccy>", "wallet currency, e.g. ZAR or USD (default: org primary)")
  .action(async (amount: string, options: { currency?: string }) => {
    const cents = Number(amount);
    const result = await api<{ wallet: { available: number; currency: string } }>("/v1/wallet/fund", {
      method: "POST",
      body: JSON.stringify({ amount: cents, currency: options.currency }),
    });
    p.log.success(`Wallet funded. Available: ${formatCents(result.wallet.available, result.wallet.currency)}`);
  });

program
  .command("balance")
  .description("Show wallet balances (all currencies)")
  .action(async () => {
    const { wallets } = await api<{
      wallets: Array<{ available: number; posted: number; held: number; currency: string }>;
    }>("/v1/wallet");
    for (const wallet of wallets) {
      p.log.info(
        `${wallet.currency}: Available ${formatCents(wallet.available, wallet.currency)} · Held ${formatCents(wallet.held, wallet.currency)} · Posted ${formatCents(wallet.posted, wallet.currency)}`,
      );
    }
  });

program
  .command("create-card")
  .description("Create a virtual card interactively")
  .action(async () => {
    p.intro("Create a virtual card");
    const label = await p.text({ message: "What is this card for?", placeholder: "agent groceries" });
    if (p.isCancel(label)) return p.cancel("cancelled");
    const currency = await p.select({
      message: "Card currency",
      options: [
        { value: "ZAR", label: "ZAR — South African Rand" },
        { value: "USD", label: "USD — US Dollar" },
      ],
      initialValue: "ZAR",
    });
    if (p.isCancel(currency)) return p.cancel("cancelled");
    const singleUse = await p.confirm({ message: "Single use (auto-close after first charge)?", initialValue: true });
    if (p.isCancel(singleUse)) return p.cancel("cancelled");
    const limitRaw = await p.text({ message: "Per-transaction limit in cents (blank for none)", placeholder: "50000" });
    if (p.isCancel(limitRaw)) return p.cancel("cancelled");
    const thresholdRaw = await p.text({
      message: "Human approval threshold in cents (blank for none)",
      placeholder: "20000",
    });
    if (p.isCancel(thresholdRaw)) return p.cancel("cancelled");

    const spinner = p.spinner();
    spinner.start("Issuing card");
    const { card } = await api<{ card: any }>("/v1/cards", {
      method: "POST",
      body: JSON.stringify({
        label: label || undefined,
        currency,
        single_use: singleUse,
        limits: limitRaw ? { per_transaction: Number(limitRaw) } : undefined,
        approval_threshold: thresholdRaw ? Number(thresholdRaw) : undefined,
      }),
    });
    spinner.stop("Card issued");
    p.note(
      `id:      ${card.id}\nccy:     ${card.currency}\npan:     ${card.sandboxPan} (sandbox)\nexpiry:  ${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear}\nsingle:  ${card.singleUse}`,
      card.label ?? "card",
    );
    p.outro("Done");
  });

program
  .command("cards")
  .description("List cards")
  .action(async () => {
    const { cards } = await api<{ cards: any[] }>("/v1/cards");
    if (cards.length === 0) return p.log.info("No cards yet. Run `acard create-card`.");
    for (const card of cards) {
      p.log.message(`${card.id}  ****${card.last4}  ${card.status.padEnd(6)}  ${card.label ?? ""}`);
    }
  });

program
  .command("close-card <cardId>")
  .description("Close a card")
  .action(async (cardId: string) => {
    await api(`/v1/cards/${cardId}/close`, { method: "POST" });
    p.log.success(`Card ${cardId} closed`);
  });

program
  .command("transactions")
  .description("List transactions")
  .option("--card <cardId>", "filter by card")
  .action(async (options: { card?: string }) => {
    const qs = options.card ? `?card_id=${options.card}` : "";
    const { transactions } = await api<{ transactions: any[] }>(`/v1/transactions${qs}`);
    if (transactions.length === 0) return p.log.info("No transactions yet.");
    for (const t of transactions) {
      const line = `${t.createdAt}  ${t.status.padEnd(9)}  ${formatCents(t.amount, t.currency).padStart(12)}  ${t.merchantName}${t.declineReason ? `  (${t.declineReason})` : ""}`;
      p.log.message(line);
    }
  });

program
  .command("approvals")
  .description("Review pending human approvals")
  .action(async () => {
    const { approvals } = await api<{ approvals: any[] }>("/v1/approvals?status=pending");
    if (approvals.length === 0) return p.log.info("No pending approvals.");
    for (const approval of approvals) {
      const decision = await p.select({
        message: `${approval.merchantName} — ${formatCents(approval.amount, approval.currency)} (${approval.reason})`,
        options: [
          { value: "approve", label: "Approve" },
          { value: "deny", label: "Deny" },
          { value: "skip", label: "Skip" },
        ],
      });
      if (p.isCancel(decision) || decision === "skip") continue;
      await api(`/v1/approvals/${approval.id}/${decision}`, { method: "POST" });
      p.log.success(`${decision === "approve" ? "Approved" : "Denied"} ${approval.id}`);
    }
  });

program
  .command("simulate-purchase <cardId> <amount> <merchant>")
  .description("Sandbox: simulate a merchant charging the card")
  .option("--mcc <mcc>", "merchant category code", "5999")
  .action(async (cardId: string, amount: string, merchant: string, options: { mcc: string }) => {
    const result = await api<any>("/v1/simulate/purchase", {
      method: "POST",
      body: JSON.stringify({
        card_id: cardId,
        amount: Number(amount),
        merchant: { name: merchant, category: options.mcc },
      }),
    });
    if (result.approved) {
      p.log.success(`Approved. Wallet available: ${formatCents(result.wallet.available, result.wallet.currency)}`);
    } else if (result.approval_id) {
      p.log.warn(`Pending human approval (${result.approval_id}). Run \`acard approvals\` to decide, then retry.`);
    } else {
      p.log.error(`Declined: ${result.decline_reason}`);
    }
  });

program.parseAsync(process.argv);
