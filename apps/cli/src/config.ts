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

export function loadConfig(): CliConfig {
  if (!existsSync(file)) return { apiUrl: process.env.ACARD_API_URL ?? "http://localhost:8787" };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CliConfig;
  return { ...parsed, apiUrl: process.env.ACARD_API_URL ?? parsed.apiUrl };
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
}
