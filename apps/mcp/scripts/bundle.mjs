import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundles the A-CARD MCP server (stdio) into one file with its dependencies
 * inlined, for the agent-app plugins in plugins/acard/. The plugins run it
 * with plain `node`: no npm install, no tsx, no clone of this repository.
 *
 *   npm run plugins:build
 *
 * The output is committed (plugin marketplaces install straight from git),
 * and a test fails if it no longer matches what this script produces.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const version = JSON.parse(readFileSync(join(root, "plugins", "acard", ".claude-plugin", "plugin.json"), "utf8")).version;

export async function bundle({ write = true } = {}) {
  const result = await build({
    entryPoints: [join(here, "..", "src", "index.ts")],
    outfile: join(root, "plugins", "acard", "server", "acard-mcp.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    minify: false,
    legalComments: "none",
    write,
    logLevel: "warning",
    // Some dependencies are CommonJS and call require(); give the ESM bundle one.
    banner: {
      js: `// A-CARD MCP server ${version}, bundled from apps/mcp by apps/mcp/scripts/bundle.mjs. Do not edit.\nimport { createRequire as __acardCreateRequire } from "node:module";\nconst require = __acardCreateRequire(import.meta.url);`,
    },
  });
  return result.outputFiles?.[0]?.text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bundle();
  console.log("wrote plugins/acard/server/acard-mcp.mjs");
}
