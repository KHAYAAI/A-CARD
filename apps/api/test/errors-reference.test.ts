import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * docs/reference/errors.md promises to list every error code and decline
 * reason the platform can return. This holds it to that: scan the source for
 * every code that can reach a caller and require each one to be documented.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const reference = readFileSync(join(root, "docs/reference/errors.md"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const sources = [...sourceFiles(join(root, "packages/core/src")), ...sourceFiles(join(root, "apps/api/src"))]
  .filter((path) => !path.endsWith("openapi.ts") && !path.endsWith("responses.ts"))
  .map((path) => readFileSync(path, "utf8"));

function collect(pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const source of sources) for (const match of source.matchAll(pattern)) found.add(match[1] as string);
  return [...found].sort();
}

const documented = (code: string) => reference.includes(`\`${code}\``);

describe("docs/reference/errors.md", () => {
  it("documents every API error code", () => {
    const codes = new Set([
      ...collect(/new DomainError\(\s*"([a-z_]+)"/g),
      ...collect(/\bcode:\s*"([a-z_]+)"/g),
      // Codes set by the DomainError subclasses rather than at the throw site.
      "not_found",
      "insufficient_funds",
      "invalid_state",
    ]);
    expect(codes.size).toBeGreaterThan(40);
    expect([...codes].filter((code) => !documented(code))).toEqual([]);
  });

  it("documents every decline and review reason", () => {
    const reasons = [
      ...collect(/declineRecord\([^)]*?,\s*"([a-z_]+)"\)/g),
      ...collect(/decision:\s*"(?:decline|review)",\s*reason:\s*"([a-z_]+)"/g),
    ];
    expect(reasons).toContain("pending_human_approval");
    expect(reasons).toContain("velocity_limit_exceeded");
    expect(reasons.filter((reason) => !documented(reason))).toEqual([]);
  });

  it("documents every webhook signature failure reason", () => {
    const reasons = collect(/reason:\s*"((?:missing|malformed|bad|timestamp)_[a-z_]+)"/g);
    expect(reasons.length).toBe(5);
    expect(reasons.filter((reason) => !documented(reason))).toEqual([]);
  });
});
