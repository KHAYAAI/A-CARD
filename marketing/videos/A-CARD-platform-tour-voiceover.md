# A-CARD platform tour: voice-over script

For `A-CARD-platform-tour.mp4` (now 6:08: the wallet section gained two dropdown beats). About 780 words at a calm 140 words a minute.
Timings below are from the earlier 5:40 cut: from the wallets section (3:40) onward, add about 25 seconds. They are approximate (±5 s): the video is paced by captions, so read to the
scene, not the clock. Lines in *italics* are stage directions, not read aloud.
Say "sandbox" every time the screen says it. Do not say "live", "launched" or "certified".

---

**0:00 · Title**
Agents can now find things and decide what to buy. They still can't pay safely.
A shared card number is all or nothing: no limit per task, no merchant rules, no audit trail, and no person in the loop. Companies won't hand that to software.

**0:13 · What A-CARD is**
A-CARD is the control layer between an agent and money. Every payment gets its own limits, rules and approvals, on whichever rail is cheapest and safest. Cards, wallets and stablecoins, with one ledger.

**0:20 · Five parts**
The platform has five parts.
A-CARD issues virtual cards for agents, with spend limits, category rules, approvals and an instant freeze.
A-MERCHANT is the supplier directory: an agent searches, compares, and gets a priced offer it can pay.
AFP, the Agent Financial Platform, routes each payment to card, x402 or stablecoin, by cost, speed and finality.
Wallets hold fiat and crypto. Every account gets an embedded wallet, and users can link their own.
And agent access: an MCP server, SDK, CLI, and plugins for Claude Code, Codex and OpenClaw.

**0:30 · The sandbox**
This is the public sandbox: the whole platform on test money. A chat on one side, the console behind it. The agent you'll see is scripted, so the demo is repeatable. A visitor can plug in their own Claude key for a live agent.

**0:40 · 1. Buying**
First, buying. I ask for milk and eggs. The agent searches A-MERCHANT, and the offers come back with price and supplier, possibly from two different shops.
*(basket)* The buyer picks what goes in. Fees are shown before paying: an order fee and a card-processing fee. That's how A-CARD earns, per transaction.
*(checkout)* One card is issued for the whole order, limited to just those merchant categories. It can't be used anywhere else, and it closes when the order is paid.

**1:25 · 2. Controls**
Now the same agent, asked to do something it shouldn't. A casino, on a general card. It's declined at authorization: the category isn't allowed. The reason is logged.
Next, a large payment. Above the approval threshold, the payment waits for a human. The agent cannot approve its own spend.
*(approve)* The person approves, and the payment goes through.

**2:05 · 3. The console**
This is the console, what a finance or operations team sees.
Cards: every card the agents made, with its limit and rules, and one click to close.
Spending: every transaction, including the declines.
Approvals: the queue where a person decides, for cards and wallet transfers.
Policies: spend caps, category lists and thresholds, set once and enforced on every authorization.
The audit log: who or what did what, and when. It's the record a compliance team asks for.
Merchants: the directory agents search. Supply matters, because the more suppliers there are, the more useful agents become, and the more agents there are, the more suppliers want in.

**3:00 · Sell on A-CARD**
Any shop can list itself. Tell us who you are, then upload your products from a spreadsheet.
In production, a new store stays hidden until we've verified the business. In the sandbox it's verified for you, but only your own chat can see it.
Prices in rands, one row per product. If a row is wrong, we say which one; the good rows still go in.
*(store opens)* The store is live in your sandbox, and the agent can buy from it. Supplier onboarding, end to end, in minutes.

**3:40 · 4. Wallets**
Wallets. One place for fiat and crypto.
Fiat balances in rand and dollars fund the cards.
Crypto: an embedded wallet is created for every account at signup. Users can also link their own: MetaMask, WalletConnect, Coinbase, Solana.
And the agent's own wallet, with its own limits. Small payments go through, larger ones need a person, and above the hard cap they're refused.
*(routing)* Then routing. Say what you want to pay, and AFP scores each rail on cost, speed and finality. Cards are fast but can be reversed for months. Stablecoins settle instantly and finally. Each option shows its trade-off, and one ledger records them all.

*(Wallets, extra beat)* Pick the chain and the wallet app from a list with their marks; the platform checks the address format for the chain. In routing, choose who you're paying: an API, a supplier's wallet, or a merchant on a card. The choice decides which rails can carry it.

**4:30 · 5. Machine payments**
Agents also pay APIs directly, per call, using the x402 standard. The agent sets its own ceiling; anything above it is refused, and the payment is recorded like any other.
For the wallet: twenty USDC needs approval. Ninety is over the cap and refused outright.

**4:55 · 6. Connect your agent**
And to use all of this from your own agent, there's an MCP server, a TypeScript SDK, a CLI, and a plugin for Claude Code, Codex and OpenClaw.

**5:05 · How it makes money**
How it makes money: fees per transaction on orders and card processing, a share of interchange with the issuing partner, a margin on crypto routing, and subscriptions for teams. The fees in the sandbox are illustrative, not final pricing.

**5:15 · Where it stands**
Where it stands, plainly. The API, dashboard, MCP server, SDK, plugins, routing, x402, the agent wallet and the supplier directory are built and tested.
Crypto runs on test networks only, against a simulated chain, and it hasn't been audited.
And it is not live. Card issuing is simulated until our issuing partner goes live. No real money moves today, and there is no SOC 2 report yet.

**5:30 · The ask**
What we're looking for: an issuing partner, design customers, and investors to take this from sandbox to live issuance. Try the sandbox yourself, then let's talk.

**5:38 · Close**
A-CARD. Cards and wallets for AI agents.

---

## Recording notes
- Read the "Where it stands" paragraph exactly; it is the claim-safety paragraph.
- Keep the pace slower than feels natural in the console section, where captions change every five seconds.
- If you add a voice-over track, the captions can stay: they carry the same points for viewers who watch muted.
- The 548-tests figure on the "where it stands" slide is now 557. Left unsaid in the script on purpose.
