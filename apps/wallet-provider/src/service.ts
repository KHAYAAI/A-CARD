import { randomUUID } from "node:crypto";
import { open, seal, generateKey, toHex } from "./crypto.js";
import { evmBalance, evmTransfer, isEvmAddress, checksum } from "./evm.js";
import { ProviderError } from "./errors.js";
import { solanaBalance, solanaTransfer } from "./solana.js";
import type { KeyStore } from "./store.js";
import type { Chain, Network, TransferRecord } from "./types.js";
import { base58 } from "@scure/base";

export interface ProviderConfig {
  masterKey: Buffer;
  store: KeyStore;
  networks: Record<Chain, Network>;
  /** Max USDC (base units) in a single transfer. */
  maxTransfer: bigint;
  /** Max USDC (base units) per wallet in any rolling 24 hours. */
  maxDaily: bigint;
  confirmTimeoutMs?: number;
  log?: (line: string) => void;
}

export const usdc = (whole: number) => BigInt(Math.round(whole * 1_000_000));

const isSolanaAddress = (a: string) => {
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
};

export class ProviderService {
  private locks = new Map<string, Promise<unknown>>();
  private log: (line: string) => void;
  constructor(readonly cfg: ProviderConfig) {
    this.log = cfg.log ?? ((l) => process.stderr.write(l + "\n"));
  }

  private audit(event: string, fields: Record<string, unknown>) {
    // Never includes key material: only ids, addresses, amounts and hashes.
    this.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
  }

  network(chain: Chain): Network {
    return this.cfg.networks[chain];
  }

  status() {
    return {
      store: this.cfg.store.kind,
      networks: Object.values(this.cfg.networks).map((n) => ({ chain: n.chain, network: n.name, testnet: n.testnet, rpc: Boolean(n.rpcUrl), transfers: n.kind === "evm" })),
      testnet: Object.values(this.cfg.networks).every((n) => n.testnet),
      limits: { maxTransfer: this.cfg.maxTransfer.toString(), maxDaily: this.cfg.maxDaily.toString(), unit: "USDC base units (6 decimals)" },
    };
  }

  /** Idempotent per (user, chain): a second call returns the same wallet and never makes another key. */
  async createWallet(userId: string, chain: Chain) {
    return this.serial(`create:${userId}:${chain}`, async () => {
      const existing = await this.cfg.store.getWallet(userId, chain);
      if (existing) return { address: existing.address, chain, created: false };
      const k = generateKey(chain);
      const rec = { id: randomUUID(), userId, chain, address: k.address, sealed: seal(this.cfg.masterKey, k.secret, userId, chain, k.address), createdAt: new Date().toISOString() };
      k.secret.fill(0);
      await this.cfg.store.putWallet(rec);
      this.audit("wallet.created", { userId, chain, address: k.address });
      return { address: k.address, chain, created: true };
    });
  }

  private needRpc(n: Network) {
    if (!n.rpcUrl) throw new ProviderError(503, "rpc_not_configured", `no RPC endpoint configured for ${n.chain} (${n.name})`);
  }

  async balance(chain: Chain, address: string) {
    const n = this.network(chain);
    this.validAddress(n, address);
    this.needRpc(n);
    const raw = n.kind === "evm" ? await evmBalance(n, address) : await solanaBalance(n, address);
    return { balance: Number(raw) / 1e6, raw: raw.toString(), asset: "USDC", decimals: 6, network: n.name, testnet: n.testnet };
  }

  private validAddress(n: Network, a: string) {
    const ok = n.kind === "evm" ? isEvmAddress(a) : isSolanaAddress(a);
    if (!ok) throw new ProviderError(400, "bad_address", `not a valid ${n.chain} address`);
  }

  /**
   * Moves USDC out of a wallet this provider created. Policy is checked before
   * the key is ever opened; the key lives in memory only for the signing call.
   */
  async transfer(req: { chain: Chain; from: string; to: string; amount: string; idempotencyKey: string }) {
    const n = this.network(req.chain);
    if (n.kind !== "evm") solanaTransfer();
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(req.idempotencyKey ?? "")) throw new ProviderError(400, "bad_idempotency_key", "idempotencyKey must be 8-128 characters");
    if (!/^\d{1,18}$/.test(req.amount ?? "")) throw new ProviderError(400, "bad_amount", "amount must be a whole number of USDC base units (6 decimals)");
    const amount = BigInt(req.amount);
    if (amount <= 0n) throw new ProviderError(400, "bad_amount", "amount must be positive");
    this.validAddress(n, req.from);
    this.validAddress(n, req.to);
    if (!n.testnet && process.env.PROVIDER_ALLOW_MAINNET !== "true") throw new ProviderError(403, "mainnet_disabled", "mainnet transfers are disabled");

    const fromKey = req.from.toLowerCase();
    return this.serial(`xfer:${fromKey}`, async () => {
      const prior = await this.cfg.store.getTransfer(req.idempotencyKey);
      if (prior) {
        if (prior.fromAddress.toLowerCase() !== fromKey || prior.to.toLowerCase() !== req.to.toLowerCase() || prior.amount !== req.amount || prior.chain !== req.chain)
          throw new ProviderError(409, "idempotency_conflict", "that idempotency key was already used for a different transfer");
        return { txHash: prior.txHash, confirmed: prior.confirmed, replayed: true };
      }
      const wallet = await this.cfg.store.getWalletByAddress(req.chain, req.from);
      if (!wallet) throw new ProviderError(404, "unknown_wallet", "this provider holds no wallet with that address");
      if (fromKey === req.to.toLowerCase()) throw new ProviderError(422, "policy", "cannot transfer to the same wallet");
      if (amount > this.cfg.maxTransfer) throw new ProviderError(422, "policy", `over the per-transfer limit of ${Number(this.cfg.maxTransfer) / 1e6} USDC`);
      const spent = (await this.cfg.store.transfersSince(req.chain, req.from, Date.now() - 86_400_000)).reduce((a, t) => a + BigInt(t.amount), 0n);
      if (spent + amount > this.cfg.maxDaily) throw new ProviderError(422, "policy", `over the 24-hour limit of ${Number(this.cfg.maxDaily) / 1e6} USDC`);
      this.needRpc(n);

      const secret = open(this.cfg.masterKey, wallet.sealed, wallet.userId, wallet.chain, wallet.address);
      let res: { txHash: string; confirmed: boolean };
      try {
        res = await evmTransfer(n, toHex(secret), checksum(req.to), amount, this.cfg.confirmTimeoutMs);
      } finally {
        secret.fill(0);
      }
      const rec: TransferRecord = { key: req.idempotencyKey, fromAddress: wallet.address, chain: req.chain, to: req.to, amount: req.amount, txHash: res.txHash, confirmed: res.confirmed, at: new Date().toISOString() };
      await this.cfg.store.putTransfer(rec);
      this.audit("transfer", { chain: req.chain, from: wallet.address, to: req.to, amount: req.amount, txHash: res.txHash, confirmed: res.confirmed, network: n.name });
      return { txHash: res.txHash, confirmed: res.confirmed, replayed: false };
    });
  }

  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }
}
