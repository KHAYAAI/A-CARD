# LangChain / LangGraph (Python)

Load the A-CARD MCP tools into a LangChain agent with `langchain-mcp-adapters`.

```bash
pip install langchain langchain-mcp-adapters langchain-anthropic
```

```python
import asyncio
import os

from langchain.agents import create_agent
from langchain_mcp_adapters.client import MultiServerMCPClient

SYSTEM = (
    "You buy with an A-CARD card. Every payment is checked against the card's rules. "
    "If a payment is declined, report the decline_reason; never split a purchase to get under a limit. "
    "If a charge is pending_human_approval, stop and say what needs approving. Amounts are integer cents."
)

async def main():
    client = MultiServerMCPClient({
        "acard": {
            "command": "npx",
            "args": ["tsx", "/absolute/path/to/a-card/apps/mcp/src/index.ts"],
            "transport": "stdio",
            "env": {
                **os.environ,  # keep PATH so `npx` resolves
                "ACARD_API_URL": "http://localhost:8787",
                "ACARD_API_KEY": os.environ["ACARD_API_KEY"],
            },
        }
    })
    tools = await client.get_tools()

    agent = create_agent("anthropic:claude-opus-5-5", tools, system_prompt=SYSTEM)
    result = await agent.ainvoke({
        "messages": [{"role": "user", "content": "Create a single-use grocery card capped at R500 and pay R120 at Woolworths Food (MCC 5411)."}]
    })
    print(result["messages"][-1].content)

asyncio.run(main())
```

Things to know:

- **Pass `os.environ` through in `env`.** Without `PATH`, the child process can't find `npx`.
- Any LangChain chat model works. Swap the model string for your provider (e.g. `"openai:gpt-4.1"`) and install its integration package.
- Each tool returns MCP content blocks. A decline is a successful tool call whose text contains `"approved": false` and a `decline_reason`, so the model sees it and can explain it.

**Verified** with `langchain-mcp-adapters` 0.3.2 and `langchain` 1.4.7: `MultiServerMCPClient` connected to the real A-CARD MCP server over stdio, `get_tools()` returned all nine tools then available, `get_wallet` executed and returned the live balance, and `create_agent` is exported from `langchain.agents`. The agent run itself needs a model provider key and wasn't executed.
