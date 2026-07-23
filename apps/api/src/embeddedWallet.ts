import type { Chain } from "@acard/core";

/**
 * Thin client for an embedded-wallet provider (e.g. a hardened, independently
 * deployed successor to open-privy) that custodies keys and signs on behalf
 * of the platform's users. A-CARD never vendors that provider's code or
 * database — it only calls two endpoints over HTTPS:
 *
 *   POST {baseUrl}/wallets        create a wallet for a user on a chain
 *   GET  {baseUrl}/wallets/:id/balance   read its balance
 *
 * This keeps the provider swappable (or replaceable by an in-house service)
 * without touching `packages/core` or the REST route handlers, which only
 * depend on the `EmbeddedWalletClient` shape below.
 */

export interface EmbeddedWalletConfig {
  baseUrl: string;
  apiKey: string;
  /** Chain to auto-provision at signup when the caller doesn't specify one. */
  defaultChain?: Chain;
}

export interface ProvisionedWallet {
  address: string;
  chain: Chain;
}

export class EmbeddedWalletClient {
  readonly defaultChain: Chain;

  constructor(private readonly config: EmbeddedWalletConfig) {
    this.defaultChain = config.defaultChain ?? "ethereum";
  }

  /** Ask the provider to create (or return the existing) wallet for this user on this chain. */
  async createWallet(accountHolderId: string, chain: Chain = this.defaultChain): Promise<ProvisionedWallet> {
    const response = await fetch(`${this.config.baseUrl}/wallets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: accountHolderId, chain }),
    });
    if (!response.ok) {
      throw new Error(`embedded wallet provider create failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { address: string; chain: Chain };
    return { address: body.address, chain: body.chain };
  }

  async getBalance(address: string, chain: Chain): Promise<string> {
    const response = await fetch(
      `${this.config.baseUrl}/wallets/balance?address=${encodeURIComponent(address)}&chain=${encodeURIComponent(chain)}`,
      { headers: { authorization: `Bearer ${this.config.apiKey}` } },
    );
    if (!response.ok) {
      throw new Error(`embedded wallet provider balance lookup failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { balance: string };
    return body.balance;
  }
}
