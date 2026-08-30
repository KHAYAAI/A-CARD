# Tutorial production scripts

These generate the recordings in `tutorials/`. Nothing is mocked: the dashboard
footage is a real browser driving the real Next.js app against a real API, and
every terminal block replays a command that was actually executed, with its
actual stdout.

## How it works

| File | Role |
|---|---|
| `lib.mjs` | Recording harness — Playwright video capture, caption bar, animated cursor, title/end cards, and the terminal player. |
| `capture.mjs` | **Runs each demo command for real** against the live API and writes its genuine output to `scenes.json`. |
| `ep01…ep09.mjs` | One file per episode. |
| `finalize.sh` | Transcodes the newest take of each episode to H.264/MP4 and writes it into `tutorials/` under its published name. |
| `stills.mjs` | Captures high-resolution (2×, 2560×1600) dashboard stills into `tutorials/stills/`, dark and light. Seeds its own on-brand demo account first (SA merchants, ZAR, real decline reasons). Built for marketing/motion-design use, where a screen gets tilted and pushed into hard enough that a 1× grab goes soft. |

The separation matters: `capture.mjs` executes, the episode scripts only
*replay*. If the platform's behaviour changes, re-running `capture.mjs`
regenerates the truth and every terminal scene updates with it.

## Running

```bash
# 1. start the platform (two terminals, from the repo root)
PORT=8787 DASHBOARD_URL=http://localhost:3000 npx tsx apps/api/src/index.ts
cd apps/dashboard && NEXT_PUBLIC_ACARD_API_URL=http://localhost:8787 npx next dev -p 3000

# 2. install Playwright for the recorder
cd tutorials/production
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # playwright + ffmpeg-static

# 3. capture real command output, then record
node capture.mjs
for f in ep0*.mjs; do node "$f"; done
bash finalize.sh
```

Each episode seeds its own account through the API, so takes are independent and
repeatable — no shared fixture to reset between runs.

## Notes

- `lib.mjs` points `executablePath` at the preinstalled Chromium. Change it if
  yours lives elsewhere, or drop the line to let Playwright resolve its own.
- Playwright captures VP8/WebM at 1280×720; `finalize.sh` transcodes to
  H.264/MP4 (CRF 20, `+faststart`), which plays everywhere and is about half
  the size. Raw takes stay in `tutorials/.raw/` and are gitignored.
- `page.setContent()` replaces the SPA, so any episode that shows a full-screen
  slide and then returns to the dashboard must call `resume(page)` first. That
  bug is easy to reintroduce.

## Marketing stills

```bash
# with the platform running (see above)
node stills.mjs
```

Writes 12 PNGs to `tutorials/stills/` — six views (overview, cards, spending,
wallet, approvals, connect) × dark and light. The seeded data is deliberately
on-brand rather than generic: ZAR amounts, South African merchants (Checkers
Sixty60, Bolt, FlySafair, a Bree Street taxi rank), and a spend history that
shows the product's actual behaviour on screen — completed charges, a
`per_transaction_limit_exceeded` decline, and a `pending_human_approval` hold.

Each run seeds a fresh account, so re-running regenerates everything cleanly.
