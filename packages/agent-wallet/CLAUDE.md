# CLAUDE.md — FORGE Agent Wallet

## Read first

This is a **clean-room** project. Before doing anything, read `CLEANROOM.md`.

- Never fetch, open, clone, search or quote the source of `lopushok9/Agent-Layer`
  or any non-permissively licensed wallet project. If a task seems to need it,
  stop and ask.
- Work from `SPEC.md`. If the spec is silent, design it yourself and record
  the decision in `docs/decisions.md`.
- Add a line to the provenance log in `CLEANROOM.md` for every feature.
- Only add dependencies with MIT / Apache-2.0 / BSD / ISC / MPL-2.0 licences.
  Run `npm run licences` after adding one.

## What this is

An MCP server that gives AI agents (Claude Code, Codex, Cursor, any MCP host)
governed wallet capabilities: balances, send/receive, x402 paid APIs, and
later swaps and A-CARD virtual cards. Agents get **capabilities, never keys**.
Every money movement goes through: `policy.evaluate → (approval if required)
→ signer.sign → chain.broadcast → ledger event`.

## Layout

```
src/
  server.ts        MCP server + tool registration (stdio)
  tools/           one file per tool group (wallet, x402, cards)
  policy/          spend policy engine (limits, allow-lists, approval rules)
  signer/          Signer interface + implementations (local dev, openfireblocks)
  chains/          Chain adapters (mock, base, solana)
  events.ts        ForgePayEvent emitter → Revenue Ontology (unified-router)
  config.ts        config loading + validation
test/              vitest
```

## Commands

- `npm run build` — compile TypeScript
- `npm test` — run tests
- `npm run dev` — start the MCP server on stdio with the mock chain
- `npm run licences` — fail if a dependency licence is not on the allow-list

## Non-negotiables

- Policy is evaluated **before** any signer call, and fails closed.
- Tools that move value return a preview first; execution needs the preview id.
- No private key material is ever returned by a tool, logged, or put in an event.
- Amounts are integers in the asset's smallest unit (strings in JSON). No floats.
