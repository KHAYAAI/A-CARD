import type { ChainId } from "./types.js";

export interface DefiPosition {
  protocol: string;
  asset: string;
  /** Integer string in the asset's smallest unit. */
  supplied: string;
  apyBps?: number;
}

/** Read-only view of lending and yield positions. Nothing here moves money. */
export interface DefiProvider {
  readonly id: string;
  positions(address: string, chain: ChainId): Promise<DefiPosition[]>;
}

/** Sandbox: there is no market, so there are never positions. */
export class SandboxDefiProvider implements DefiProvider {
  readonly id = "sandbox";
  async positions(): Promise<DefiPosition[]> {
    return [];
  }
}
