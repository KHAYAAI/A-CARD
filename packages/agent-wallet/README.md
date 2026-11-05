# FORGE Agent Wallet

Governed wallet for AI agents over MCP. Agents get capabilities, never keys:
every transfer is previewed, checked against policy (limits, allow/deny lists,
sanctions), approved by a human when required, signed, and recorded as a
`ForgePayEvent` for the Revenue Ontology and Credit Bureau.

Clean-room implementation — see [CLEANROOM.md](CLEANROOM.md). Spec: [SPEC.md](SPEC.md).

## Status

v0.1 scaffold: MCP server (stdio), policy engine, dev signer, mock chain, events,
9 tests. Next: Base Sepolia adapter, x402, openfireblocks signer, A-CARD cards.

## Try it

```bash
npm install
npm run build
npm test
```

Add to Claude Code:

```bash
claude mcp add forge-wallet -- node /absolute/path/to/dist/server.js
```

Then ask: "check my wallet balance on mock" or "send 5 USDC to merchant-1".
Transfers above 10 USDC need approval; above 50 USDC are denied (dev defaults).
