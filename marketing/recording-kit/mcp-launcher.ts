import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Claude Desktop's entry point for the recording kit. Reads the running kit's
 * API URL and agent key from .kit/state.json, then starts the real A-CARD MCP
 * server (apps/mcp) over stdio. The key never sits in Claude Desktop's config
 * file, and the config stays the same from take to take.
 *
 * stdout belongs to the MCP protocol: everything human-readable goes to stderr,
 * which Claude Desktop writes to its MCP log.
 */

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), ".kit", "state.json");

if (!existsSync(STATE_FILE)) {
  console.error("A-CARD recording kit isn't running. Start it with `npm run recording-kit`, then restart Claude Desktop.");
  process.exit(1);
}
const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { apiUrl: string; agentKey: string };
process.env.ACARD_API_URL = state.apiUrl;
process.env.ACARD_API_KEY = state.agentKey;

await import("../../apps/mcp/src/index.js");
