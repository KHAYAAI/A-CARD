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
| 11 | 2026-11-05 | An execute attempt before approval doesn't consume the preview | Burning it made the human's approval unusable and forced a fresh preview and a second approval |
