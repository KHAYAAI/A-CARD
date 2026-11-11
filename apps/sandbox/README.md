# A-CARD public sandbox

A chat page where anyone can try the whole platform on test money: a Claude agent with every A-CARD tool (cards, merchant rules, human approval, A-MERCHANT search, card and wallet x402, the on-chain wallet with transfers and swaps), next to a live panel of the visitor's own sandbox account, where the visitor, never the agent, decides approvals.

- Each visitor gets a fresh account: R20 000 and US$500 in the fiat wallet, 500 test USDC on a mock chain.
- The real A-CARD API runs in-process (`/v1/*`), with a seeded A-MERCHANT directory and a paid x402 test API at `/demo/weather`.
- Limits: 40 messages a session, 12 tool calls a message, 6 new sessions per IP per hour.
- In memory: a restart resets everything. Run one instance.

## Run locally

```bash
ANTHROPIC_API_KEY=… npm start -w @acard/sandbox     # http://localhost:8080
```

Without a key the page loads and the panel works, and the chat reports that the agent is offline. The key can also be put in `~/.acard-sandbox-key` (owner-only), and is re-read on every call.

## Deploy to Fly.io

From the repository root:

```bash
fly apps create acard-sandbox
fly secrets set ANTHROPIC_API_KEY=… --app acard-sandbox     # typed into your own terminal
fly deploy --config apps/sandbox/fly.toml --dockerfile apps/sandbox/Dockerfile .
fly scale count 1 --app acard-sandbox
```

## Tests

`npm test -w @acard/sandbox` drives the whole flow with a scripted stand-in for the model: supply search, a held card charge approved from the panel, wallet x402 against the demo API, a held wallet transfer, the message cap.
