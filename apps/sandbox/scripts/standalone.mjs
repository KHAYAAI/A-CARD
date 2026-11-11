import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One self-contained HTML file that runs the entire sandbox in the browser:
 * the A-CARD platform, the scripted demo agent, the MCP tools and the wallet.
 * No server. Attach it, host it anywhere static, or open it from disk.
 *
 *   npm run standalone -w @acard/sandbox   ->  apps/sandbox/dist/a-card-sandbox.html
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const shims = join(root, "browser", "shims");

const result = await build({
  entryPoints: [join(root, "browser", "main.ts")],
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true, legalComments: "none", logLevel: "warning",
  inject: [join(shims, "globals.ts")],
  alias: {
    "node:crypto": join(shims, "crypto.ts"),
    "node:net": join(shims, "net.ts"),
    "node:dns/promises": join(shims, "dns.ts"),
    "node:url": join(shims, "url.ts"),
    pg: join(shims, "empty.ts"),
    "@aws-sdk/client-s3": join(shims, "empty.ts"),
    buffer: join(root, "..", "..", "node_modules", "buffer", "index.js"),
  },
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
});
const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
const page = readFileSync(join(root, "public", "index.html"), "utf8");
const html = page.replace("<script>", () => `<script>${js}</script>\n<script>`);
mkdirSync(join(root, "dist"), { recursive: true });
const out = join(root, "dist", "a-card-sandbox.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1048576).toFixed(2)} MB)`);
