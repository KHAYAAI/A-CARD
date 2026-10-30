# A-CARD plugin for Claude Code, Codex and OpenClaw

One plugin folder serves all three apps. It gives your agent the A-CARD MCP server, with its 10 tools: per-task cards, merchant payments, x402 API payments, A-MERCHANT supply search, the wallet and transactions. It also adds a skill that teaches the agent to scope cards and respect declines.

The server is a single bundled file (`server/acard-mcp.mjs`) that needs only **Node.js 20 or later**: no npm install, and no clone of this repository.

## 1. Connect your A-CARD account (once per machine)

You need an agent API key (`ak_…`). Get one from the A-CARD console, or run `acard signup` in the sandbox. Then:

```bash
node <plugin folder>/server/acard-mcp.mjs setup --api-key ak_… --api-url https://your-a-card-api
```

This writes `~/.acard/config.json` with owner-only permissions. It's the same file the `acard` CLI uses. Leave out `--api-url` to use the local sandbox (`http://localhost:8787`).

In Claude Code you can skip this step and enter the key when you enable the plugin instead. It's stored in your system's secure credential store.

## 2. Install

### Claude Code

```
/plugin marketplace add khayaai/a-card
/plugin install acard@a-card
```

Or from a shell: `claude plugin marketplace add khayaai/a-card`, then `claude plugin install acard@a-card`.

### Codex

```bash
codex plugin marketplace add khayaai/a-card
codex plugin add acard@a-card
```

Codex reads `.agents/plugins/marketplace.json` and runs the server with the plugin folder as its working directory.

### OpenClaw

From a clone of this repository:

```bash
openclaw plugins install ./plugins/acard
```

OpenClaw asks you to confirm installing from a local path and to accept the plugin's capabilities (`--force --accept-capabilities` does both). It loads this folder as a Codex-format bundle: the skill plus the MCP server.

`khayaai/a-card` is a private repository. The marketplace commands work for anyone with access to it. Publishing the plugin more widely (Anthropic's plugin directory, ClawHub) is a separate step that needs a public source.

## What was verified

| | How |
|---|---|
| Claude Code | `claude plugin validate` passed for the plugin and the marketplace. Installed through `claude plugin marketplace add` and `install`; `claude mcp list` showed `plugin:acard:acard … √ Connected`. |
| Codex (CLI 0.166.0) | `codex plugin marketplace add` and `codex plugin add` installed it into Codex's plugin cache, with `cwd` resolved to the plugin root. The server ran from that cached copy and served all 10 tools against a live API. |
| OpenClaw (2026.10.9) | `openclaw plugins install` installed it and `plugins doctor` passed. `plugins inspect` showed a Codex-format bundle with skills and an MCP server, and OpenClaw's own MCP loader reported the server as runnable over stdio. The server ran from the installed copy. |
| The server itself | `apps/api/test/plugins.test.ts` launches the committed bundle as Claude Code and Codex do, against a live API. It creates a card and pays an x402 API through it. It also fails if the bundle is stale. |

Not yet done: a full agent conversation inside each app, because that needs a signed-in model account in each one.

## For maintainers

`server/acard-mcp.mjs` is built from `apps/mcp` with `npm run plugins:build` and committed, because marketplaces install straight from git. Bump `version` in all three manifests together (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `openclaw.plugin.json`); a test checks they match.
