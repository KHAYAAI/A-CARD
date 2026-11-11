# A-CARD public sandbox

A chat page where anyone can try the whole platform on test money, next to a live panel of the visitor's own sandbox account, where the visitor (never the agent) decides approvals.

**Two modes, and the server needs no secrets for either:**

- **Demo agent (default, free).** A scripted agent: no AI model, no key. It makes the same tool calls Claude would, to the real sandbox platform: supply search and a scoped single-use card, a fuel card refusing a TV, a charge held for approval then retried once, x402 pay-per-call, a 20 USDC transfer held and 90 USDC refused, a USDC to ZARP swap. Anything else gets a short list of what it can do. The page labels it "Demo agent · scripted".
- **Live Claude (optional, bring your own key).** A visitor adds their own Anthropic key in the page. It travels with each request over HTTPS, is used for that call only, and is never stored or logged by the server (it stays in the visitor's browser tab). The agent then has all 21 tools and handles free-form requests. Usage bills to the visitor's own Anthropic account.

Screens, as in the console: Agent (chat), Manage cards, Track spending, Wallet, Approvals, Policies, Audit log, Merchants and Connect agents. They read the visitor's real records from the in-process API through `/sandbox/api/*`, an allow-list of the console's own endpoints (no keys, members or merchant admin). A visitor can edit organisation policy, close cards, add test funds and decide approvals, and nothing else.

Restrictions shown and enforced: an organisation policy (gambling and crypto blocked to start, editable under Policies) that beats any card's rules, per-card limits and approval thresholds, wallet limits (10 USDC auto-approve, 50 per transfer, 200 a day, x402 up to 1 USDC) and x402 price ceilings.

**Free-form requests in demo mode:** beyond the curated example scenarios, the scripted agent reads plain English (`src/freeform.ts`, a rule-based interpreter, not a language model) and makes the real tool calls: search or buy anything in the catalogue, create cards with the limits described, pay a named merchant, check balances, cards, spending and approvals, close cards, send or swap in the wallet. Requests outside the platform get an honest "can't do that here" and a pointer to live mode. In the sandbox, agents' x402 calls can only reach the built-in demo API.

**Layout:** chat first. One centred column with a slim header (brand, Console, settings, New conversation), compact one-line tool steps, approvals and the cart docked above the message box, and a few suggestion pills. The full console (cards, spending, wallet, approvals, policies, audit, merchants, connect) is behind the **Console** button. Settings (live Claude key, theme, messages left) are in the **⋯** menu. On phones the tab bar appears only in the console, tables reflow into stacked rows, inputs are 16px (no iOS zoom) and the composer respects the safe area.

**The agent's crypto access:** two read-only tools on top of the platform's own: `list_crypto_wallets` (the linked embedded and external wallets and embedded USDC balances; the agent can't link, unlink or move them) and `quote_payment` (which rail would carry a payment and why; quotes only). Sandbox-only: the published MCP server and plugin don't have them.

**Testing live Claude (needs your key):** `ANTHROPIC_API_KEY=sk-ant-… npm run live-smoke -w @acard/sandbox` runs eight real requests through Claude (balance, card, search, crypto wallets, payment quote, wallet transfer, a policy-blocked casino charge, a purchase) and prints PASS/FAIL for each, for a few cents. `test/live.test.ts` separately checks, against a strict stand-in for the Messages API, that the live path sends conversations that API's rules accept and recovers cleanly from service errors. That stand-in cannot prove the real service or Claude's behaviour: the smoke test does.

**Several products in one request:** "milk and eggs", "buy 2 hard hats and 3 hi-vis vests" search each product separately and show a labelled set of results for each. Buying them pays every supplier from one card capped at the whole order, then pays the fees once, then closes the card. The cart holds items from several suppliers at once and checks out the same way.

**Wallet screen (fiat, crypto, agent, routing):** built on what the platform has, not mock-ups.
- *Fiat*: the ZAR and USD wallets (available, held, posted) with card activity. Top-ups are instant test money; live ZAR top-ups go through PayFast.
- *Crypto wallets*: the platform's linked wallets. Every account gets an embedded wallet per chain (ethereum, polygon, solana) from a custody provider, and can link external wallets (MetaMask, WalletConnect, Coinbase). Addresses are validated per chain by the platform, one wallet is the default, the embedded wallet can't be unlinked. The provider is stood in for by `/sandbox/embedded/*` with deterministic addresses and test USDC.
- *Agent wallet*: the on-chain wallet the agent uses (`@acard/agent-wallet`): balances, its limits and how much of the daily allowance is used, pending approvals and a history of what it did.
- *Pay & routing*: AFP. Say what you want to pay; the card, stablecoin and x402 rails are each quoted and scored on cost, speed and finality, with reasons, then the payment is executed on the chosen rail and posted to one ledger with its finality (instant = settled; card = posted for the 120-day reversal window). The stablecoin rail here is a sandbox rail that moves test USDC between in-memory embedded-wallet balances.

**Catalogue:** about 18 fictional suppliers and ~120 products around Johannesburg (groceries, pharmacy, electronics, office, workwear and safety, cleaning, auto parts, catering, building, fuel and tyres), defined in `src/catalogue.ts`. Several suppliers stock the same product so ranking has something to decide, and one is deliberately unverified so you can see agents never get offered it. Prices are plausible shelf prices, not quotes. Product pictures are line illustrations drawn for each kind of product (no photographs).

**Fees:** the cart adds an order fee and card processing, charged through the real ledger as a separate payment to "a·card fees" (category 7399) on the same card. The rates (`FEES` in `public/index.html`) are placeholders, not A-CARD pricing: set them to what you decide to charge, or to zero.

**Live mode check:** "Check key" in the key dialog makes a one-token call and says plainly whether the key works, is rejected, is rate-limited, or can't be reached.

Each visitor gets a fresh account: R20 000 and US$500 in the fiat wallet, 500 test USDC on a mock chain. The real A-CARD API runs in-process (`/v1/*`) with a seeded A-MERCHANT directory and a paid x402 test API at `/demo/weather`.

Limits: 40 messages a session, 12 tool calls a message, 6 new sessions per IP per hour. Everything is in memory: a restart resets it, so run one instance.

## One HTML file, no server

`apps/sandbox/a-card-sandbox.html` is the whole sandbox in a single file (0.9 MB): the A-CARD platform, the demo agent, the MCP tools and the wallet, all running in the visitor's browser. Attach it to an email, drop it on any static host (GitHub Pages, S3, Netlify, a USB stick), or just double-click it. Nothing is sent to any server, and reloading resets it. In live mode a visitor's own Anthropic key goes only from their browser straight to Anthropic.

Rebuild it after changing the sandbox: `npm run standalone -w @acard/sandbox`, then copy `apps/sandbox/dist/a-card-sandbox.html` over `apps/sandbox/a-card-sandbox.html`.

## Run locally

```bash
npm start -w @acard/sandbox     # http://localhost:8080
```

## Deploy to Fly.io

From the repository root:

```bash
fly apps create acard-sandbox
fly deploy --config apps/sandbox/fly.toml --dockerfile apps/sandbox/Dockerfile .
fly scale count 1 --app acard-sandbox
```

No secrets to set.

## Tests

`npm test -w @acard/sandbox` runs every demo scenario against the real platform (no model, no key), and checks that live mode uses a visitor's key for that request only and keeps nothing.
