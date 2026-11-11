import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Chain, TransferRecord, WalletRecord } from "./types.js";

/** Where sealed keys and the transfer log live. Keys are only ever stored sealed (see crypto.ts). */
export interface KeyStore {
  readonly kind: "memory" | "file";
  getWallet(userId: string, chain: Chain): Promise<WalletRecord | undefined>;
  getWalletByAddress(chain: Chain, address: string): Promise<WalletRecord | undefined>;
  putWallet(record: WalletRecord): Promise<void>;
  getTransfer(key: string): Promise<TransferRecord | undefined>;
  putTransfer(record: TransferRecord): Promise<void>;
  transfersSince(chain: Chain, address: string, sinceMs: number): Promise<TransferRecord[]>;
}

interface Snapshot {
  wallets: WalletRecord[];
  transfers: TransferRecord[];
}

export class MemoryKeyStore implements KeyStore {
  readonly kind: "memory" | "file" = "memory";
  protected wallets: WalletRecord[] = [];
  protected transfers: TransferRecord[] = [];

  async getWallet(userId: string, chain: Chain) {
    return this.wallets.find((w) => w.userId === userId && w.chain === chain);
  }
  async getWalletByAddress(chain: Chain, address: string) {
    return this.wallets.find((w) => w.chain === chain && w.address.toLowerCase() === address.toLowerCase());
  }
  async putWallet(record: WalletRecord) {
    this.wallets.push(record);
    this.persist();
  }
  async getTransfer(key: string) {
    return this.transfers.find((t) => t.key === key);
  }
  async putTransfer(record: TransferRecord) {
    this.transfers.push(record);
    this.persist();
  }
  async transfersSince(chain: Chain, address: string, sinceMs: number) {
    return this.transfers.filter((t) => t.chain === chain && t.fromAddress.toLowerCase() === address.toLowerCase() && Date.parse(t.at) >= sinceMs);
  }
  protected persist() {}
}

/**
 * A JSON file, written atomically (temp file + rename) with owner-only
 * permissions. It refuses to open a file that other users can read, since the
 * sealed keys inside are only as private as the file is.
 */
export class FileKeyStore extends MemoryKeyStore {
  override readonly kind = "file" as const;

  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
        throw new Error(`${path} is readable by other users; run: chmod 600 ${path}`);
      }
      const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
      this.wallets = snap.wallets ?? [];
      this.transfers = snap.transfers ?? [];
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.persist();
    }
  }

  protected override persist() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ wallets: this.wallets, transfers: this.transfers }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
