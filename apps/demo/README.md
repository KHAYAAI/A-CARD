# A-CARD — Investor / Partner Demo

A single self-contained HTML file (`index.html`) that walks the whole A-CARD
story from a login screen: sign in → issue an AI agent a card → watch a
purchase clear **real-time authorization** → **approve** a flagged charge →
spend across **ZAR and USD** wallets → see the **double-entry ledger** balance.

It runs the *actual* authorization logic from `packages/core` (rules engine,
double-entry ledger, human-in-the-loop grants, multi-currency wallets),
faithfully re-implemented in the browser — same decisions, same states — so
it's 100% reliable in a boardroom with **no backend, no network, no real
money**.

## How to present it

- **Live link (easiest):** open the published Artifact URL on any screen. It's
  private to you until you share it.
- **Local / offline:** just open `apps/demo/index.html` in any browser. Nothing
  to install.
- **Host it:** drop the single file on any static host (S3, Netlify, GitHub
  Pages).

## The narrative (built-in "Demo guide" rail scripts this)

1. **Sign in** as Khaya AI — two prepaid wallets, ZAR and USD, are ready.
2. **Run the grocery agent** (Checkers Sixty60) → clears authorization in real
   time, wallet updates.
3. **Try Steam on the grocery card** → declined: merchant category not allowed.
4. **Run the R6 500 flight** (FlySafair) → over threshold, **held for your
   approval**.
5. **Approve it** → the agent retries on a one-time grant and it clears.
6. **Run OpenAI in USD** → the USD wallet moves, ZAR is untouched.
7. **Issue a new card** to an agent with your own limits and rules.

Theme toggle (◐) and "Reset demo" are in the top bar. It's fully keyboard- and
mobile-friendly and respects reduced-motion.

## Relationship to the real product

The demo mirrors the real platform's behaviour but is intentionally a
client-side simulation for reliability while presenting. The production system
is the REST API + Postgres multi-writer store + MCP server + dashboard in this
repo; see the root `README.md` and `docs/DEPLOYMENT.md`.
