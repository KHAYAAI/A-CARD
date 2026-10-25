# Claude

Four ways to give Claude an A-CARD card, from no code to full control.

| | Code | A-CARD runs | Best for |
|---|---|---|---|
| [Claude Desktop](#claude-desktop) | none | locally (stdio) | Trying it, demos, personal agents |
| [Claude Code](#claude-code) | none | locally or deployed | Developer workflows |
| [Claude API + tool runner](#the-claude-api) | TypeScript | anywhere | Production agents in your own service |
| [Claude API + MCP connector](#the-mcp-connector) | a few lines | **deployed** (public HTTPS) | Calling A-CARD's tools from the API without hosting tool code |

---

## Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "acard": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/a-card/apps/mcp/src/index.ts"],
      "env": {
        "ACARD_API_URL": "http://localhost:8787",
        "ACARD_API_KEY": "ak_live_…"
      }
    }
  }
}
```

Restart Claude Desktop. Try:

> Create a single-use grocery card capped at R500, then pay R120 at Woolworths Food (MCC 5411). Then try to use the same card again and tell me what happened.

The second charge comes back `card_closed`, because the single-use card closed after its first capture.

## Claude Code

Local (stdio):

```bash
claude mcp add acard \
  --env ACARD_API_URL=http://localhost:8787 \
  --env ACARD_API_KEY=ak_live_… \
  -- npx tsx /absolute/path/to/a-card/apps/mcp/src/index.ts
```

A deployed A-CARD (Streamable HTTP):

```bash
claude mcp add --transport http acard https://your-api-host/mcp -H "Authorization: Bearer ak_live_…"
```

Add `--scope project` to share the server with your team through `.mcp.json`, but keep the API key out of it. Have each person supply their own key through an environment variable.

---

## The Claude API

For an agent that runs inside your own service, use the Anthropic SDK's **tool runner**, with each tool a call into [`@acard/sdk`](../../packages/sdk/README.md). The runner drives the loop; A-CARD decides what's allowed.

The complete, runnable version is [`examples/02-claude-fuel-agent.ts`](../../examples/02-claude-fuel-agent.ts). The core:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { Acard } from "@acard/sdk";

const acard = new Acard({ apiKey: process.env.ACARD_API_KEY! });
const client = new Anthropic();

const payForFuel = betaZodTool({
  name: "pay_for_fuel",
  description: "Pay a fuel merchant with the agent's card. Returns approved true/false and, when declined, a decline_reason.",
  inputSchema: z.object({
    merchant_name: z.string(),
    merchant_category: z.string(),
    amount_cents: z.number().int().positive(),
  }),
  run: async ({ merchant_name, merchant_category, amount_cents }) => {
    const result = await acard.sandbox.purchase({
      card_id: process.env.FLEET_CARD_ID!,
      amount: amount_cents,
      merchant: { name: merchant_name, category: merchant_category },
    });
    return JSON.stringify({ approved: result.approved, decline_reason: result.decline_reason, approval_id: result.approval_id });
  },
});

const final = await client.beta.messages.toolRunner({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  output_config: { effort: "medium" },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system: "You buy fuel with one company card. If a payment is declined, report the decline_reason; never split a purchase to dodge a limit.",
  tools: [payForFuel /*, findFuel, checkCard */],
  messages: [{ role: "user", content: "Truck 14 needs 180 litres of diesel. Buy it." }],
});
```

Notes:

- **Zod 4.** The SDK's `betaZodTool` is typed against Zod 4. With `zod@3.25+` installed, import from `"zod/v4"`.
- **Refusal fallback** (`fallbacks: "default"`) reruns a safety-classifier decline on a fallback model inside the same call. Remove it if you'd rather see the refusal.
- **Return declines as tool results, not errors.** A decline is information Claude should act on, so the example returns it as data and only real failures (`AcardError`) become error strings.

Verified against `@anthropic-ai/sdk` 1.3.0: it typechecks, and the tools run against a live A-CARD API in [`examples/test/examples.test.ts`](../../examples/test/examples.test.ts).

---

## The MCP connector

If your A-CARD deployment is reachable over public HTTPS, Claude can call its MCP server directly from the Messages API. There's no tool code to host, because Anthropic's side connects to `/mcp`:

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const response = await client.beta.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  betas: ["mcp-client-2025-11-20", "server-side-fallback-2026-07-01"],
  fallbacks: "default",
  mcp_servers: [
    { type: "url", name: "acard", url: "https://your-api-host/mcp", authorization_token: process.env.ACARD_API_KEY! },
  ],
  tools: [{ type: "mcp_toolset", mcp_server_name: "acard" }],
  messages: [{ role: "user", content: "What's my ZAR wallet balance? Then list my open cards." }],
});
```

- Both halves are required: the server in `mcp_servers` **and** an `mcp_toolset` entry naming it.
- `authorization_token` is sent as the bearer token A-CARD's `/mcp` endpoint expects.
- It doesn't work against `localhost`, because Anthropic's servers have to reach the URL.
- Use a **scoped** key: a `read_only` key for agents that only look, or a key with `spend_cap_cents` so the key itself can't provision more card budget than you intend.

Typechecked against `@anthropic-ai/sdk` 1.3.0. Not run end to end here, because it needs a publicly deployed A-CARD.
