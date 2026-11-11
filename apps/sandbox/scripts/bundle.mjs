import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundle the sandbox into dist/ (server.mjs + index.html) to run with plain `node`. */
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "dist");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "..", "src", "index.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "none", logLevel: "warning",
  banner: { js: `import { createRequire as __cr } from "node:module";\nconst require = __cr(import.meta.url);` },
});
copyFileSync(join(here, "..", "public", "index.html"), join(out, "index.html"));
console.log("wrote apps/sandbox/dist/");
