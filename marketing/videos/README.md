# A-CARD marketing videos

Six videos from the demo & launch production pack, all recorded from the running product.

| File | Length | Format | For |
|---|---|---|---|
| `A-CARD-demo-full.mp4` | ~5½ min | 1920×1080 | Prospects, partners, the issuing-partner conversation |
| `A-CARD-product-75s.mp4` | ~1 min | 1920×1080 | Homepage hero, social |
| `A-CARD-clip-approval.mp4` | ~30 s | 1080×1080 | LinkedIn / X: "one approval, one purchase" |
| `A-CARD-clip-blocked.mp4` | ~20 s | 1080×1080 | LinkedIn / X: the fuel card that can't buy a TV |
| `A-CARD-clip-search.mp4` | ~20 s | 1080×1080 | LinkedIn / X: 500 bags of cement by tomorrow |
| `A-CARD-agent-shopping.mp4` | ~3½ min | 1920×1080 | Connect an agent over MCP, then watch it shop: groceries, a marketplace (with a prompt injection), flights held for approval |

## Agent shopping: public and private cuts

`production/agent-shopping.mjs` renders the same flow in two brand sets (`web/brands.js`):

- **`public`**: fictional stores (FreshCart, Shoply, SkyHop) and a fictional search engine. Safe to publish. This is the committed MP4.
- **`private`**: illustrative recreations of Checkers Sixty60, Takealot and FlySafair, **for showing prospective clients in private only**. A copy of a real retailer's site in public marketing implies a partnership we don't have, and it's trademark exposure. Every frame carries a *Private client demo · not for publication* badge, every store page a "not affiliated with or endorsed by" strip, and the end card repeats the disclaimer. The render goes to `marketing/videos/private/`, which is git-ignored, so it never lands in the repo. Re-render it with `node agent-shopping.mjs private && ./finalize.sh`.

In both cuts, the prompt-injecting seller ("GadgetDealz SA") is invented, and a caption says so in the private cut, so no real retailer is shown planting instructions.

What's live in the agent-shopping video: `claude mcp add` and `claude mcp list` (run in a scratch HOME, key masked by Claude Code itself), the MCP tool list and every A-CARD tool call (Streamable HTTP MCP server on :8788), every payment decision (the store's checkout posts to A-CARD's issuer webhook through `web/server.mjs`, exactly as a card network would), and the approval click in the dashboard. What's scripted: the agent's browsing and its words. There's no LLM in the loop, and an on-screen caption says so.

## What's real, and what isn't

**Real:**
- Every **terminal block** shows the output of a command executed seconds earlier against the running API: the `acard` CLI, `curl`, the A-CARD MCP server called through an MCP client, and the merchant POS example (`examples/05-merchant-pos-sync.ts`) running as a real process.
- Every **dashboard moment** is a live browser session in the real Next.js console, including the approval click.
- The **Slack message** is the actual text A-CARD's notifier posted, captured by a local webhook receiver and shown as Slack renders it.
- Timings shown (e.g. "round trip 53 ms") are measured on the recording machine.

**Not real, and labelled so:**
- It's the **sandbox**. Every frame carries a *SANDBOX · DEMO DATA* badge, and every video ends with "Sandbox shown. Live card issuance launches with our issuing partner."
- **Khaya Logistics and every merchant are fictional** (seeded by `examples/seed-demo-world.ts`).
- The cold open's card number is an illustration (`4242…`, a test number).
- The **MCP scenes use an MCP client**, not Claude Desktop's UI. They're the exact tool calls Claude makes, and the terminal title says so.
- **No voiceover.** Narration is burned-in captions, so the videos work muted (most social video plays muted). Recording a voiceover needs a person or a TTS service.

**Not made yet:** 9:16 vertical recuts. The square clips work on LinkedIn and X; vertical versions need their own layout rather than a crop.

## How they're made

`production/` holds everything:

| File | Role |
|---|---|
| `demo-server.ts` | Runs the real `createApp` with the in-memory platform on :8787, seeds the demo world through the public API, and mints the one merchant API key directly (that normally needs a WorkOS portal session). Also sets the demo org to the enterprise plan, as a settled subscription would, so agent scenes aren't capped at the free tier's 5 cards a month. Writes `world.json`. |
| `real.mjs` | Real actions: the CLI, REST, the MCP server over stdio, the POS example, the captured Slack message |
| `mlib.mjs` | Recording harness: Playwright at 1920×1080 with CSS zoom (sharp, rather than upscaled), captions, cursor, the sandbox badge, slides, terminal player |
| `full-demo.mjs` · `product-75.mjs` · `clips.mjs` · `agent-shopping.mjs` | One script per video |
| `web/` | The demo web on :4400: agent console, search engine, store pages, and the payment bridge to A-CARD's issuer webhook |
| `reset-world.sh` | Fresh demo world before each take |
| `render-all.sh` | Every take, then `finalize.sh` (H.264, CRF 21, faststart) |

To re-record (needs the dashboard on :3000 and a Slack capture sink on :9911; the agent-shopping video also needs `node web/server.mjs` and the HTTP MCP server, `MCP_HTTP_PORT=8788 ACARD_API_URL=http://localhost:8787 npx tsx apps/mcp/src/index-http.ts`):

```bash
cd marketing/videos/production
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
(cd ../../../apps/dashboard && NEXT_PUBLIC_ACARD_API_URL=http://localhost:8787 npx next dev -p 3000) &
./render-all.sh
```

Playwright is pinned to 1.56.1 to match the Chromium and ffmpeg builds pre-installed in this environment.
