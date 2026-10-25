# Integrations

A-CARD reaches an agent in one of three ways. Pick the one your stack already speaks.

| Your agent is built with | Connect through | Guide |
|---|---|---|
| Claude Desktop, Claude Code | MCP (stdio or HTTP) | [claude.md](claude.md#claude-desktop) |
| The Claude API | Tool runner + `@acard/sdk`, or the MCP connector | [claude.md](claude.md#the-claude-api) |
| OpenAI Agents SDK | MCP (stdio) | [openai-agents-sdk.md](openai-agents-sdk.md) |
| LangChain / LangGraph | MCP via `langchain-mcp-adapters` | [langchain.md](langchain.md) |
| Vercel AI SDK | MCP via `@ai-sdk/mcp` | [vercel-ai-sdk.md](vercel-ai-sdk.md) |
| Anything else | REST, `@acard/sdk`, or any MCP client | [quickstart](../quickstart.md) |

## The one rule that doesn't change

However the agent connects, it reaches the same REST API through the same authorization path. **There is no privileged path.** An agent holding the MCP tools can't exceed a card's limits, buy a blocked category, or skip an approval, because every one of those checks runs server-side, in A-CARD, on every charge.

What *does* change between frameworks is how well the agent **understands** a refusal. Give it a system prompt along these lines. It's framework-neutral and every example here uses a version of it:

> Every payment is checked by A-CARD against the card's rules. If a payment is declined, read `decline_reason` and act on it: never split a purchase to get under a per-transaction limit, never retry a decline unchanged, and if a charge is `pending_human_approval`, stop and tell the user what needs approving. Amounts are integer cents.

## The MCP tools every framework sees

| Tool | Does |
|---|---|
| `create_card` | Issue a card. Single-use by default. Limits in cents, MCC allow-list, approval threshold. |
| `get_card` · `list_cards` · `close_card` | Inspect and revoke |
| `pay_checkout` | Charge a card (in the sandbox, simulates the issuer). A decline is a normal result: `approved: false` plus `decline_reason`. |
| `list_transactions` | History, with decline reasons |
| `get_wallet` | Available / held / posted, per currency |
| `find_offers` | Search A-MERCHANT for verified supply |
| `get_merchant` | A merchant's profile and catalogue |

## How these guides were verified

Each guide's code was compiled against the framework's published package, and the framework's MCP client was connected to the real A-CARD MCP server, listing all nine tools and executing a call. Package versions are in each guide. **The LLM calls themselves weren't run**, because that needs each provider's API key. If a framework has moved on since, its MCP-client setup is the only part likely to need changing; the A-CARD side is plain MCP.
