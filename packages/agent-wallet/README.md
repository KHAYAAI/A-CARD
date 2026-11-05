# FORGE Agent Wallet

Governed wallet for AI agents over MCP. Agents get capabilities, never keys:
every transfer is previewed, checked against policy (limits, allow/deny lists,
sanctions), approved by a human when required, signed, and recorded as a
`ForgePayEvent` for the Revenue Ontology and Credit Bureau.

Clean-room implementation — see [CLEANROOM.md](CLEANROOM.md). Spec: [SPEC.md](SPEC.md).

## Status

Built, sandbox only: MCP tools (transfers, x402, swaps, DeFi reads), policy engine,
approvals, dev signer, mock chain, events, an `openfireblocks` threshold-signer
client, and the mainnet gate. 30 tests.

Not built: a real chain adapter (Base, Solana), a real swap aggregator, and real
DeFi reads. Each needs network access and a funded account this project doesn't
have yet. The card tools in the spec aren't duplicated: A-CARD's own `create_card`,
`list_cards` and `close_card` are the card tools. The `openfireblocks` signer was
written against a contract of our own (see `src/signer/openfireblocks.ts`) and
must be checked against the real service. **Nothing here is audited or live.**

## In A-CARD's MCP server

`apps/mcp` mounts these tools (`registerWalletTools`) when started with `ACARD_ENABLE_WALLET=true`, so the A-CARD plugin for Claude Code, Codex and OpenClaw offers cards and the wallet together. See [plugins/acard](../../plugins/acard/README.md). It's sandbox only there.

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
