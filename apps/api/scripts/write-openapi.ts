import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApi } from "../src/openapi.js";
import { renderMarkdown } from "../src/openapiMarkdown.js";

/**
 * Writes docs/api/openapi.json and its rendered markdown reference,
 * docs/api/reference.md. Run with `npm run openapi` from the repo root.
 */
const doc = buildOpenApi();
const json = fileURLToPath(new URL("../../../docs/api/openapi.json", import.meta.url));
const markdown = fileURLToPath(new URL("../../../docs/api/reference.md", import.meta.url));
writeFileSync(json, `${JSON.stringify(doc, null, 2)}\n`);
writeFileSync(markdown, renderMarkdown(doc));
console.log(`wrote ${json}\nwrote ${markdown}`);
