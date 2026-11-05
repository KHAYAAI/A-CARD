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
