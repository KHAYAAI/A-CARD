# Vercel AI SDK

Use the A-CARD MCP tools with `generateText` / `streamText` through `@ai-sdk/mcp`.

```bash
npm install ai @ai-sdk/mcp @ai-sdk/anthropic
```

```ts
import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

const acard = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["tsx", "/absolute/path/to/a-card/apps/mcp/src/index.ts"],
    env: { ACARD_API_URL: "http://localhost:8787", ACARD_API_KEY: process.env.ACARD_API_KEY! },
  }),
});

try {
  const { text } = await generateText({
    model: anthropic("claude-opus-5-5"),
    tools: await acard.tools(),
    stopWhen: stepCountIs(10),
    system: "You buy with an A-CARD card. Report any decline_reason; never split a purchase to dodge a limit.",
    prompt: "Create a single-use grocery card capped at R500 and pay R120 at Woolworths Food (MCC 5411).",
  });
  console.log(text);
} finally {
  await acard.close();
}
```

Things to know:

- **`stopWhen: stepCountIs(n)`** lets the model take several tool steps (create a card, then pay). Without it, generation stops after the first tool call.
- **Stdio is for servers you run.** In a serverless deployment (e.g. Vercel functions), you can't spawn a child process per request. Point the MCP client at a deployed A-CARD's `/mcp` over HTTP instead, with the API key as a bearer header, or call [`@acard/sdk`](../../packages/sdk/README.md) from your own `tool()` definitions.
- Close the client in `finally`. Each stdio client is a child process.

**Verified** with `ai` 7.0.153, `@ai-sdk/mcp` 2.0.84 and `@ai-sdk/anthropic` 4.0.88: the code above typechecks, and the client connected to the real A-CARD MCP server, listed all nine tools and executed `get_wallet`. The `generateText` call needs a model provider key and wasn't executed.
