import type { MockChain } from "./chains/mock.js";
import type { ChainId } from "./types.js";

export interface SwapQuote {
  provider: string;
  chain: ChainId;
  assetIn: string;
  assetOut: string;
  amountIn: bigint;
  amountOut: bigint;
  /** The least the swap may return; below this it must fail. */
  minAmountOut: bigint;
  expiresAt: number;
}

/**
 * Where swaps are priced and executed: a DEX aggregator in production. The
 * wallet never trusts a provider's number blindly: policy bounds the slippage
 * (`amountOut` vs `minAmountOut`) before anything is signed.
 */
export interface SwapProvider {
  readonly id: string;
  quote(req: { chain: ChainId; assetIn: string; assetOut: string; amountIn: bigint }): Promise<SwapQuote>;
  execute(quote: SwapQuote, ctx: { from: string }): Promise<{ txHash: string; amountOut: bigint }>;
}

/**
 * Sandbox provider: fixed rates on the mock chain, no real market. Rates are
 * fractions so there are no floats: `{ num: 185, den: 10 }` is 18.5 out per 1 in.
 */
export class MockSwapProvider implements SwapProvider {
  readonly id = "mock-swap";

  constructor(
    private readonly chain: MockChain,
    private readonly rates: Record<string, { num: bigint; den: bigint }> = { "USDC>ZARP": { num: 185n, den: 10n }, "ZARP>USDC": { num: 10n, den: 185n } },
    private readonly slippageBps = 50n,
    private readonly now: () => number = Date.now,
  ) {}

  async quote(req: { chain: ChainId; assetIn: string; assetOut: string; amountIn: bigint }): Promise<SwapQuote> {
    const rate = this.rates[`${req.assetIn}>${req.assetOut}`];
    if (!rate) throw new Error(`no_route:${req.assetIn}>${req.assetOut}`);
    const amountOut = (req.amountIn * rate.num) / rate.den;
    return {
      provider: this.id,
      ...req,
      amountOut,
      minAmountOut: (amountOut * (10_000n - this.slippageBps)) / 10_000n,
      expiresAt: this.now() + 60_000,
    };
  }

  async execute(quote: SwapQuote, ctx: { from: string }): Promise<{ txHash: string; amountOut: bigint }> {
    if (this.now() > quote.expiresAt) throw new Error("quote_expired");
    this.chain.debit(ctx.from, quote.assetIn, quote.amountIn);
    this.chain.credit(ctx.from, quote.assetOut, quote.amountOut);
    return { txHash: `0xswap${quote.amountIn}${quote.amountOut}`.slice(0, 66), amountOut: quote.amountOut };
  }
}
