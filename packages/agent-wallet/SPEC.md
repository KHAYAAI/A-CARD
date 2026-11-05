# FORGE Agent Wallet — Specification

Status: v0.2, 2026-11-05. Phases 1–4 are built in the sandbox (see README); chain adapters, a real swap aggregator, the real signer contract and the audit are not. Written from public material only (see `CLEANROOM.md`).

## 1. Goal

Give any MCP-capable AI agent a governed wallet: it can see balances, move
money, and pay for services, but only inside limits a human set, with every
movement recorded in FORGE's Revenue Ontology. One install command; works in
Claude Code, Codex, Cursor and any stdio/HTTP MCP host.

**Differentiators vs other agent wallets**

| | FORGE Agent Wallet |
|---|---|
| Keys | Threshold signing via openfireblocks (2-of-3), or local dev key; agent never sees keys |
| Governance | Policy engine + human approvals + sanctions screening before signing |
| Fiat | A-CARD virtual cards (ZAR and USD) from the same tool surface |
| Record | Every action emits a signed `ForgePayEvent` → Revenue Ontology → Credit Bureau |
| Market | South Africa first: ZAR, ZARP, local card issuing |

## 2. Users

- **Agent operator** (developer or business): installs, funds, sets policy, approves.
- **Agent**: calls tools. Untrusted by default — treat every tool call as possibly prompt-injected.

## 3. Tool surface (MCP)

All amounts are strings of integers in the asset's smallest unit. Every tool
that moves value is two-step: `*_preview` returns a `preview_id` plus the
policy decision; `*_execute` takes the `preview_id` and only runs if the
decision was `allow`, or `require_approval` and the approval was granted.

### Phase 1 — core (week 1–2)
| Tool | Purpose |
|---|---|
| `wallet_status` | Wallets, chains, addresses, policy summary |
| `get_balances` | Balances per wallet / chain / asset |
| `list_activity` | Recent movements with status |
| `send_preview` / `send_execute` | Transfer a native asset or token |
| `receive_info` | Address (and later payment request) to receive funds |
| `approval_status` | Check a pending approval |

### Phase 2 — x402 and services (week 2)
| `x402_preview` / `x402_pay` | Pay an HTTP 402 challenge (USDC on Base first) and return the resource |

### Phase 3 — swaps and DeFi reads (week 3)
| `swap_quote` / `swap_execute` | Via a permissively licensed aggregator API |
| `defi_positions` | Read-only positions (lending, yield) |

### Phase 4 — FORGE integrations (week 3–4)
| `card_create` / `card_list` / `card_close` | A-CARD virtual cards funded from ZAR/USD wallets |
| Signer: openfireblocks | Replace dev signer with threshold signing |
| Events → unified-router | Production event sink |

### Phase 5 — distribution (week 4–5)
- `npx @forge/agent-wallet install` — detects hosts, writes MCP config, starts runtime
- Claude Code plugin marketplace + Codex marketplace listings
- Remote MCP (Streamable HTTP + OAuth) for cloud/mobile hosts

## 4. Policy engine

Evaluated before every signer call. Fails closed: any error → `deny`.

Rules (per wallet, configurable in JSON; later OPA/Rego shared with openfireblocks):
- Per-transaction limit per asset
- Rolling 24h limit per asset
- Recipient allow-list / deny-list
- Allowed chains and assets
- `approval_above`: amounts over this need a human approval
- x402: max price per request, allowed domains
- Sanctions screening hook (compliance-monitor) — deny on hit or if list is stale

Decision: `allow | require_approval | deny`, with machine-readable reasons.

## 5. Signer

```ts
interface Signer {
  id: string;
  address(chain: ChainId): Promise<string>;
  sign(request: SignRequest): Promise<SignedTx>; // never exposes key material
}
```
Implementations: `DevSigner` (local, testnet only, refuses mainnet), `OpenFireblocksSigner` (HTTP to openfireblocks API with ceremony co-signing).

## 6. Events

Every preview decision and execution emits a `ForgePayEvent`
(`agent_wallet.transfer.previewed|executed|denied`, `agent_wallet.x402.paid`,
...) with agent id, wallet id, chain, asset, amount, counterparty, policy
decision and tx hash. Sink: stdout/JSONL in dev; unified-router in prod.

## 7. Security requirements

- No key material in tool output, logs or events.
- Preview ids are single-use and expire (default 5 minutes).
- Execute re-checks policy (limits may have changed since preview).
- Mainnet disabled unless signer is openfireblocks and config explicitly enables it.
- External audit before real funds.

## 8. Out of scope (v1)

Custodial hosted wallets (see open-privy decision), lending, agent credit lines, NFT tooling.
