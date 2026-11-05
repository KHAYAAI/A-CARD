// Fails if any runtime dependency of this package (transitively) has a licence
// outside the clean-room allow-list. Works standalone or inside the A-CARD npm
// workspace, where dependencies are hoisted to the repo root.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ALLOWED = /^(\(?(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|MPL-2\.0|0BSD|BlueOak-1\.0\.0|CC0-1\.0|Unlicense|Python-2\.0|CC-BY-4\.0)\)?( (OR|AND) )?)+$/;

/** Node-style lookup: walk up from `fromDir` looking in node_modules/<name>. */
function findPkgDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const seen = new Map(); // pkgDir -> "name@version: licence"
const bad = [];
const missing = [];

function walk(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
  for (const name of Object.keys(deps)) {
    const dir = findPkgDir(name, pkgDir);
    if (!dir) {
      if (!(pkg.optionalDependencies && name in pkg.optionalDependencies)) missing.push(`${name} (from ${pkg.name})`);
      continue;
    }
    if (seen.has(dir)) continue;
    const j = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const lic = typeof j.license === "string" ? j.license : j.license?.type ?? "UNKNOWN";
    seen.set(dir, `${j.name}@${j.version}: ${lic}`);
    if (!ALLOWED.test(lic)) bad.push(seen.get(dir));
    walk(dir);
  }
}

walk(resolve("."));
if (missing.length) {
  console.error("Dependencies not installed (run npm install):\n" + missing.join("\n"));
  process.exit(1);
}
if (bad.length) {
  console.error(`Licence check failed (${bad.length} of ${seen.size}):\n` + bad.join("\n"));
  process.exit(1);
}
console.log(`Licence check passed: ${seen.size} runtime packages, all on the allow-list.`);
