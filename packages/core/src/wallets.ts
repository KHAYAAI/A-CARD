import { newId } from "./ids.js";
import { InvalidStateError, NotFoundError } from "./errors.js";

/**
 * Crypto wallet linking: every account holder gets one platform-provisioned
 * "embedded" wallet per chain automatically (no seed phrase, no setup step),
 * and can additionally link any number of "external" wallets (MetaMask,
 * WalletConnect, ...) they already control. Exactly one linked wallet is
 * flagged `isDefault` at a time.
 *
 * This module only tracks the linking relationship and is fully synchronous,
 * matching the rest of `Platform`. The actual wallet provisioning (a network
 * call to an embedded-wallet provider) happens at the API edge — see
 * `apps/api/src/embeddedWallet.ts` — which then calls `recordEmbeddedWallet`
 * to store the result. Core never talks to that provider directly.
 */

export type Chain = "ethereum" | "polygon" | "solana";
export type WalletKind = "embedded" | "external";
export type ExternalWalletConnector = "metamask" | "walletconnect" | "coinbase" | "other";

export interface LinkedWallet {
  id: string;
  accountHolderId: string;
  kind: WalletKind;
  chain: Chain;
  address: string;
  /** Only set for kind "external" — which connector supplied this wallet. */
  connector?: ExternalWalletConnector;
  label?: string;
  isDefault: boolean;
  createdAt: string;
}

const ADDRESS_PATTERN: Record<Chain, RegExp> = {
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  polygon: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

export function isValidAddress(chain: Chain, address: string): boolean {
  return ADDRESS_PATTERN[chain].test(address);
}

export class WalletLinkService {
  private readonly wallets = new Map<string, LinkedWallet>();

  /** Store a provider-issued embedded wallet address. Idempotent per (holder, chain). */
  recordEmbeddedWallet(accountHolderId: string, chain: Chain, address: string): LinkedWallet {
    const existing = [...this.wallets.values()].find(
      (w) => w.accountHolderId === accountHolderId && w.kind === "embedded" && w.chain === chain,
    );
    if (existing) return existing;
    return this.add({ accountHolderId, kind: "embedded", chain, address });
  }

  /** Link a wallet the user already controls. No embedded wallet is required first or after. */
  linkExternalWallet(input: {
    accountHolderId: string;
    chain: Chain;
    address: string;
    connector: ExternalWalletConnector;
    label?: string;
  }): LinkedWallet {
    if (!isValidAddress(input.chain, input.address)) {
      throw new InvalidStateError(`"${input.address}" is not a valid ${input.chain} address`);
    }
    const duplicate = [...this.wallets.values()].find(
      (w) =>
        w.accountHolderId === input.accountHolderId &&
        w.chain === input.chain &&
        w.address.toLowerCase() === input.address.toLowerCase(),
    );
    if (duplicate) throw new InvalidStateError("this wallet is already linked to this account");
    return this.add({ ...input, kind: "external" });
  }

  private add(input: {
    accountHolderId: string;
    kind: WalletKind;
    chain: Chain;
    address: string;
    connector?: ExternalWalletConnector;
    label?: string;
  }): LinkedWallet {
    const isFirstForHolder = ![...this.wallets.values()].some((w) => w.accountHolderId === input.accountHolderId);
    const wallet: LinkedWallet = {
      id: newId("wal"),
      accountHolderId: input.accountHolderId,
      kind: input.kind,
      chain: input.chain,
      address: input.address,
      connector: input.connector,
      label: input.label,
      isDefault: isFirstForHolder,
      createdAt: new Date().toISOString(),
    };
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  list(accountHolderId: string): LinkedWallet[] {
    return [...this.wallets.values()]
      .filter((w) => w.accountHolderId === accountHolderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): LinkedWallet {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new NotFoundError("wallet", id);
    return wallet;
  }

  setDefault(accountHolderId: string, id: string): LinkedWallet {
    const target = this.get(id);
    if (target.accountHolderId !== accountHolderId) throw new NotFoundError("wallet", id);
    for (const w of this.wallets.values()) {
      if (w.accountHolderId === accountHolderId) w.isDefault = w.id === id;
    }
    return target;
  }

  /** External wallets can be unlinked; the embedded wallet always stays available as a fallback. */
  unlink(accountHolderId: string, id: string): void {
    const target = this.get(id);
    if (target.accountHolderId !== accountHolderId) throw new NotFoundError("wallet", id);
    if (target.kind === "embedded") {
      throw new InvalidStateError("the embedded wallet cannot be unlinked");
    }
    this.wallets.delete(id);
    if (target.isDefault) {
      const remaining = this.list(accountHolderId);
      if (remaining[0]) remaining[0].isDefault = true;
    }
  }

  serialize(): LinkedWallet[] {
    return [...this.wallets.values()];
  }

  static hydrate(rows: LinkedWallet[]): WalletLinkService {
    const service = new WalletLinkService();
    for (const row of rows) service.wallets.set(row.id, row);
    return service;
  }
}
