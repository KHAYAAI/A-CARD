# Clean-room provenance

FORGE Agent Wallet is an independent implementation. It is **not** derived
from the source code of AgentLayer (`lopushok9/Agent-Layer`, PolyForm Small
Business 1.0.0) or any other non-permissively licensed project.

## Rules

1. **No source access.** Nobody writing code for this repository — human or
   AI agent — opens, pastes, summarises or searches the source code of
   AgentLayer or any other project licensed for non-commercial or
   small-business-only use.
2. **Spec from public material only.** Feature requirements come from
   `SPEC.md`, which was written from public, non-code material: AgentLayer's
   README (features list, install UX, supported hosts), general industry
   knowledge, and FORGE's own repositories.
3. **Permissive dependencies only.** Allowed licences: MIT, Apache-2.0,
   BSD-2/3, ISC, MPL-2.0 (file-level). Anything else needs written approval
   recorded below. `npm run licences` checks this.
4. **Own design.** Architecture, names, file layout, schemas and tool names
   are FORGE's own. Where a public standard exists (MCP, x402, ERC-4337) we
   follow the standard, not another product's implementation.
5. **Record everything.** Every session that adds a feature appends a line to
   the log below: date, who/what, feature, inputs used.

## Provenance log

| Date | Author | Change | Inputs used |
|---|---|---|---|
| 2026-11-05 | Claude (Claude Code session, steered by Tebogo Mvelase) | Clean-room rules, SPEC.md, initial scaffold (MCP server, policy engine, signer interface, mock chain) | AgentLayer public README (feature list only), MCP spec, x402 public spec, FORGE repos (openfireblocks, ForgePayE, A-CARD). AgentLayer source deleted from the workspace before any code was written. |
| 2026-11-05 | Claude (Claude Code session, steered by Tebogo Mvelase) | Moved into A-CARD monorepo as `packages/agent-wallet`; aligned deps with workspace (zod 3, MCP SDK 1.x); licence check now walks the runtime dependency tree | Own code only |

| 2026-11-05 | Claude (Claude Code session, steered by Tebogo Mvelase) | Tools mounted on A-CARD's MCP server: `registerWalletTools`, a pluggable `ApprovalStore` (in-memory default, file-backed in `apps/mcp`), `devWallet`, package entry point. Fixed: an execute attempt before approval no longer consumes the preview | Own code only |

| 2026-11-05 | Claude (Claude Code session, steered by Tebogo Mvelase) | Phases 2–4: x402 tools (wire format and URL guard moved in from `apps/api/src/x402`, A-CARD's own code from the public x402 spec), swap and DeFi-read providers, `OpenFireblocksSigner`, mainnet gate, hosted-wallet host in `apps/mcp` | Own code only. x402 public spec (coinbase/x402 `specs/`) |

## Exceptions approved

None.
