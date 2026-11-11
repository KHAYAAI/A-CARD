# A-CARD public sandbox

A chat page where anyone can try the whole platform on test money, next to a live panel of the visitor's own sandbox account, where the visitor (never the agent) decides approvals.

**Two modes, and the server needs no secrets for either:**

- **Demo agent (default, free).** A scripted agent: no AI model, no key. It makes the same tool calls Claude would, to the real sandbox platform: supply search and a scoped single-use card, a fuel card refusing a TV, a charge held for approval then retried once, x402 pay-per-call, a 20 USDC transfer held and 90 USDC refused, a USDC to ZARP swap. Anything else gets a short list of what it can do. The page labels it "Demo agent · scripted".
- **Live Claude (optional, bring your own key).** A visitor adds their own Anthropic key in the page. It travels with each request over HTTPS, is used for that call only, and is never stored or logged by the server (it stays in the visitor's browser tab). The agent then has all 21 tools and handles free-form requests. Usage bills to the visitor's own Anthropic account.

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
