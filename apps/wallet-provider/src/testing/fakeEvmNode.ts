import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, toHex } from "viem";

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"]);

export interface ObservedTransfer {
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  nonce: number;
  chainId: number;
  contract: string;
}

/**
 * A tiny in-process JSON-RPC node for tests. It is not a mock of the provider:
 * it independently decodes each signed transaction it is sent (recovering the
 * signer from the signature), enforces chain id, nonce and token balance, and
 * applies the ERC-20 effect. It also answers a Solana token-accounts query.
 */
export async function startFakeEvmNode(opts: { chainId: number; usdc: string; delayReceipts?: boolean }) {
  const balances = new Map<string, bigint>();
  const nonces = new Map<string, number>();
  const txs = new Map<string, { raw: string; from: string; included: boolean }>();
  const transfers: ObservedTransfer[] = [];
  const solana = new Map<string, bigint>();
  const lc = (s: string) => s.toLowerCase();
  let block = 100;
  let hold = Boolean(opts.delayReceipts);
  const fail = (code: number, message: string) => ({ error: { code, message } });

  const handle = async (method: string, p: any[]): Promise<any> => {
    switch (method) {
      case "eth_chainId":
        return { result: toHex(opts.chainId) };
      case "net_version":
        return { result: String(opts.chainId) };
      case "eth_blockNumber":
        return { result: toHex(block) };
      case "eth_getTransactionCount":
        return { result: toHex(nonces.get(lc(p[0])) ?? 0) };
      case "eth_estimateGas":
        return { result: toHex(65_000) };
      case "eth_gasPrice":
        return { result: toHex(2_000_000_000) };
      case "eth_maxPriorityFeePerGas":
        return { result: toHex(1_000_000_000) };
      case "eth_getBlockByNumber":
        return { result: { number: toHex(block), hash: keccak256(toHex(block)), parentHash: keccak256(toHex(block - 1)), baseFeePerGas: toHex(1_000_000_000), gasLimit: toHex(30_000_000), gasUsed: "0x0", timestamp: toHex(Math.floor(Date.now() / 1000)), transactions: [], nonce: "0x0000000000000000", miner: "0x0000000000000000000000000000000000000000", difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", logsBloom: "0x" + "0".repeat(512), sha3Uncles: keccak256("0x"), stateRoot: keccak256("0x01"), receiptsRoot: keccak256("0x02"), transactionsRoot: keccak256("0x03"), size: "0x100", uncles: [], mixHash: keccak256("0x04") } };
      case "eth_call": {
        const { to, data } = p[0];
        if (lc(to) !== lc(opts.usdc)) return fail(-32000, "execution reverted: unknown contract");
        const d = decodeFunctionData({ abi: ERC20, data: data ?? p[0].input });
        if (d.functionName !== "balanceOf") return fail(-32000, "execution reverted");
        return { result: "0x" + (balances.get(lc(d.args[0] as string)) ?? 0n).toString(16).padStart(64, "0") };
      }
      case "eth_sendRawTransaction": {
        const raw = p[0] as `0x${string}`;
        const tx = parseTransaction(raw) as any;
        const from = await recoverTransactionAddress({ serializedTransaction: raw as any });
        if (tx.chainId !== opts.chainId) return fail(-32000, `invalid chain id ${tx.chainId}`);
        if (!tx.to || lc(tx.to) !== lc(opts.usdc)) return fail(-32000, "this node only accepts calls to the USDC contract");
        const expected = nonces.get(lc(from)) ?? 0;
        if (tx.nonce !== expected) return fail(-32000, `nonce too low: have ${tx.nonce}, want ${expected}`);
        const d = decodeFunctionData({ abi: ERC20, data: tx.data });
        if (d.functionName !== "transfer") return fail(-32000, "only transfer is supported");
        const [to, amount] = d.args as [string, bigint];
        const bal = balances.get(lc(from)) ?? 0n;
        if (bal < amount) return fail(-32000, "execution reverted: ERC20: transfer amount exceeds balance");
        balances.set(lc(from), bal - amount);
        balances.set(lc(to), (balances.get(lc(to)) ?? 0n) + amount);
        nonces.set(lc(from), expected + 1);
        const hash = keccak256(raw);
        txs.set(hash, { raw, from, included: false });
        transfers.push({ from, to, amount, txHash: hash, nonce: tx.nonce, chainId: tx.chainId, contract: tx.to });
        block += 1;
        return { result: hash };
      }
      case "eth_getTransactionReceipt": {
        const t = txs.get(p[0]);
        if (!t || hold) return { result: null };
        const tx = parseTransaction(t.raw as any) as any;
        return { result: { transactionHash: p[0], transactionIndex: "0x0", blockHash: keccak256(toHex(block)), blockNumber: toHex(block), from: t.from, to: tx.to, cumulativeGasUsed: toHex(52_000), gasUsed: toHex(52_000), effectiveGasPrice: toHex(2_000_000_000), contractAddress: null, logs: [], logsBloom: "0x" + "0".repeat(512), status: "0x1", type: "0x2" } };
      }
      case "eth_getTransactionByHash":
        return { result: null };
      case "getTokenAccountsByOwner": {
        const owner = p[0] as string;
        const amt = solana.get(owner) ?? 0n;
        return { result: { value: amt ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: amt.toString() } } } } } }] : [] } };
      }
      default:
        return fail(-32601, `method ${method} not supported by the fake node`);
    }
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const one = async (r: any) => {
        try {
          return { jsonrpc: "2.0", id: r.id, ...(await handle(r.method, r.params ?? [])) };
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, ...fail(-32603, (e as Error).message) };
        }
      };
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    transfers,
    balanceOf: (a: string) => balances.get(lc(a)) ?? 0n,
    fund: (a: string, amount: bigint) => balances.set(lc(a), (balances.get(lc(a)) ?? 0n) + amount),
    fundSolana: (owner: string, amount: bigint) => solana.set(owner, amount),
    holdReceipts: (v: boolean) => (hold = v),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
