# Design decisions

| # | Date | Decision | Why |
|---|---|---|---|
| 1 | 2026-11-05 | Two-step preview/execute for every value-moving tool | Gives policy, humans and logs a checkpoint before money moves; defends against prompt-injected one-shot transfers |
| 2 | 2026-11-05 | Policy re-evaluated at execute time | Limits, lists and sanctions can change between preview and execute |
| 3 | 2026-11-05 | Approvals are operator-only, never an agent tool | An agent must not be able to approve its own spending |
| 4 | 2026-11-05 | Amounts as integer strings in smallest unit | No float rounding on money |
| 5 | 2026-11-05 | Events to stderr in dev | stdout is reserved for the MCP stdio protocol |
| 6 | 2026-11-05 | DevSigner refuses non-testnet chains | Mainnet only via openfireblocks threshold signing |
| 7 | 2026-11-05 | Licence Apache-2.0 | Permissive, patent grant, compatible with openfireblocks/ForgePayE consumers |
| 8 | 2026-11-05 | One MCP server: A-CARD's `apps/mcp` mounts the wallet's tools via `registerWalletTools`; no second server in the plugin | A-CARD already ships the plugins for Claude Code, Codex and OpenClaw. Two servers would mean two installs and two configs |
| 9 | 2026-11-05 | The wallet is opt-in (`ACARD_ENABLE_WALLET=true`) and sandbox-only there | A plugin install must never show an agent invented balances; the dev wallet is a mock chain |
| 10 | 2026-11-05 | Approvals behind an `ApprovalStore`; `apps/mcp` uses a file store plus `acard-mcp wallet-approve` | The operator decides from another process. The in-memory store can't be reached from one. Not a security boundary on a shared machine; production routes approvals to a channel the agent can't reach |
| 12 | 2026-11-05 | x402, swaps and transfers share one gate (`#open` → approval → `#take` re-check → settle) | One place enforces preview-once, approval and re-checked policy, so a new kind of payment can't skip a step |
| 13 | 2026-11-05 | x402 and swaps are off unless the wallet's policy enables them (`policy.x402`, `policy.swap`) | Fails closed, same as the rest of the policy |
| 14 | 2026-11-05 | An x402 host the policy disallows is refused before it's contacted; the agent's `max_amount` is separate from the policy's cap | Probing a host is itself a request; the agent's expectation and the operator's ceiling are two checks |
| 15 | 2026-11-05 | x402 wire format and URL guard live in this package; `apps/api` re-exports them | One copy of the protocol code for both. Note this package is Apache-2.0 and `apps/api` is unlicensed: the moved files (A-CARD's own) are now under Apache-2.0 if this package is published |
| 16 | 2026-11-05 | No card tools in this package | A-CARD's `create_card`, `list_cards`, `close_card` are the card tools; a second set would be a duplicate. On-chain funds can't fund a fiat card without an off-ramp |
| 17 | 2026-11-05 | The openfireblocks client targets a contract we wrote (`src/signer/openfireblocks.ts`) | The service's API wasn't available to this project. Tested against a local stand-in only; verify before it signs anything real |
| 18 | 2026-11-05 | Mainnet needs signer `openfireblocks` AND `allowMainnet`, checked in the service ahead of policy | The dev signer can never unlock it, even by configuration |
| 19 | 2026-11-05 | Hosted wallets: one per API key, in memory, single instance; approvals over HTTP with an operator token the agent lacks | The HTTP server is stateless per request but a wallet isn't. A shared store is the next step if it must scale out |
| 11 | 2026-11-05 | An execute attempt before approval doesn't consume the preview | Burning it made the human's approval unusable and forced a fresh preview and a second approval |
