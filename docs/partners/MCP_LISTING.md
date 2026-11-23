# Listing A-CARD in MCP directories

`apps/mcp/server.json` is the entry for the official MCP Registry (registry.modelcontextprotocol.io), name `cc.a-card/acard`.

Before publishing:
1. **Host the remote MCP server** at `https://mcp.a-card.cc/mcp` (deploy `apps/mcp` with `start:http`, e.g. a Fly app `acard-mcp`, and point the DNS name at it). Until then, change `remotes[0].url` to the Fly URL.
2. **Prove you own the namespace:** `cc.a-card/*` requires a DNS TXT record on a-card.cc. Run `mcp-publisher login dns --domain a-card.cc` and add the TXT record it prints.
3. **Publish:** `cd apps/mcp && mcp-publisher publish`.
4. Also list in: Smithery, mcp.so, PulseMCP, Glama (each takes a GitHub URL or the registry entry), and the Claude / Cursor connector directories when they open submissions.

Keep `description` honest: sandbox, test money only, until live.
