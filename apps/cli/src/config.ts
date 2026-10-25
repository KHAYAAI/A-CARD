import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  apiUrl: string;
  apiKey?: string;
  email?: string;
}

const dir = join(homedir(), ".acard");
const file = join(dir, "config.json");

/**
 * ~/.acard/config.json, with ACARD_API_URL and ACARD_API_KEY taking precedence
 * — the same variables the MCP server reads, so one environment drives both.
 */
export function loadConfig(): CliConfig {
  const parsed: Partial<CliConfig> = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as CliConfig) : {};
  return {
    ...parsed,
    apiUrl: process.env.ACARD_API_URL ?? parsed.apiUrl ?? "http://localhost:8787",
    apiKey: process.env.ACARD_API_KEY ?? parsed.apiKey,
  };
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
}
