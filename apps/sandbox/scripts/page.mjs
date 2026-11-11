import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sandbox page, with the platform's own brand fonts (IBM Plex Sans/Mono,
 * Instrument Serif) embedded as woff2 so it matches the console and works
 * offline. The @font-face rules are taken from the dashboard's stylesheet so
 * the two never drift apart.
 */
const here = dirname(fileURLToPath(import.meta.url));
const dashboardCss = join(here, "..", "..", "dashboard", "app", "globals.css");

export function renderPage() {
  const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");
  const fonts = readFileSync(dashboardCss, "utf8").split("\n").filter((l) => l.startsWith("@font-face")).join("\n");
  if (!fonts) throw new Error("no @font-face rules found in the dashboard stylesheet");
  return html.replace("/*__FONTS__*/", () => fonts);
}
