# OpenAI Agents SDK

Connect the A-CARD MCP server to an OpenAI Agents SDK agent over stdio.

```bash
npm install @openai/agents
```

```ts
import { Agent, MCPServerStdio, run } from "@openai/agents";

const acard = new MCPServerStdio({
  name: "acard",
  command: "npx",
  args: ["tsx", "/absolute/path/to/a-card/apps/mcp/src/index.ts"],
  env: { ACARD_API_URL: "http://localhost:8787", ACARD_API_KEY: process.env.ACARD_API_KEY! },
});
await acard.connect();

try {
  const agent = new Agent({
    name: "procurement-agent",
    instructions:
      "You buy supplies with an A-CARD card. Use find_offers, then create_card sized to the offer, then pay_checkout. " +
      "If a payment is declined, report the decline_reason. Never split a purchase to get under a limit.",
    mcpServers: [acard],
  });

  const result = await run(
    agent,
    "Find 500 bags of cement near Germiston (-26.2309, 28.1772) for delivery tomorrow, under R60 000, and buy the best offer.",
  );
  console.log(result.finalOutput);
} finally {
  await acard.close();
}
```

Things to know:

- **Always `close()`.** The stdio server is a child process, and the `finally` stops it.
- `env` is passed to the child process. Set `ACARD_API_KEY` there rather than baking a key into code.
- To restrict which A-CARD tools the agent can see (for example, a reporting agent that should never pay), use the server's `toolFilter` option and allow only `get_wallet`, `list_cards` and `list_transactions`. Better still, give that agent a **`read_only` API key**. Then even if a payment tool were exposed, A-CARD would refuse it with `forbidden`.

**Verified** with `@openai/agents` 0.21.0: the code above typechecks, and `MCPServerStdio` connected to the real A-CARD MCP server and listed all nine tools. The agent run itself needs an OpenAI API key and wasn't executed.
