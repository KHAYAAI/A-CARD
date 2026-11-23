# A-CARD business model: the supplier playbook

Borrowed from how casino game studios like Spribe (Aviator) scale, applied to agent payments. Figures are illustrative, in US dollars (about R18 = $1), to be replaced with partner quotes.

## How the supplier model works
| Piece | Game studio | A-CARD |
|---|---|---|
| Product | one game, built once | the agent payment layer: cards, attached cards, wallets, policies, approvals |
| Customer | licensed casino operators, not players | platforms: AI-agent builders, wallets, marketplaces, fintech and bank apps |
| End user | the player, who sees the casino's brand | the platform's users, who see the platform's brand (white label) |
| Distribution | aggregators: one integration, hundreds of casinos | agent frameworks, MCP/tool directories, payment orchestrators, e-commerce app stores |
| Pricing | % of the operator's gross gaming revenue | % of payment volume + per-card and per-conversion fees |
| Trust | test-lab certification | security audit, PCI scope via Basis Theory, later SOC 2 / ISO 27001 |
| Licence | supplier licence; the operator holds the main licence | operate under partners first (VALR, card issuer); our own licence later |

What makes it work: build once, sell to many; each customer brings its own users; revenue grows with their volume, with no extra sales effort.

## For A-CARD
**1. Sell to platforms, not end users.** One deal with an agent platform brings all its users. Customers we'd target: South African fintech apps, banks' innovation teams, AI-agent startups, procurement and travel tools, e-commerce marketplaces.

**2. Go through aggregators.**
- MCP and agent-tool directories (we already ship an MCP server, `apps/mcp`).
- Agent frameworks (SDK packages and examples).
- Payment orchestrators and PSPs (Peach Payments, Stitch): A-CARD as a payment method.
- Commerce app stores (Shopify, WooCommerce) for A-MERCHANT.
Give aggregators 10–25% of our revenue from customers they bring, as studios do.

**3. Revenue share instead of flat fees.**
| Stream | Indicative price |
|---|---|
| Card spend by agents | 0.5–1.5% of volume (or our share of interchange from the issuer) |
| USDC ⇄ local currency conversion (via VALR) | 0.25–0.75% per conversion on top of VALR's fee |
| Platform fee | $300–$2,800/month by tier, credited against volume fees |
| Active cards or wallets | $0.30–$1.00 per active card per month |
| A-MERCHANT | free listing; 1–3% commission on agent orders |

**Worked example (illustrative):** a platform with 2,000 users whose agents spend $200 a month each = $400,000 of monthly volume. At 1% that is $4,000 a month; if an aggregator introduced it, 20% ($800) goes to them and we keep $3,200. Twenty such platforms ≈ $64,000 a month (about $770,000 a year), from twenty integrations rather than 40,000 individual sign-ups.

## What this needs from the product

**Built (2026-11-23):** items 1–4 below. Guide: `docs/partners/INTEGRATION.md`; MCP listing: `docs/partners/MCP_LISTING.md`. Still to do: the hosted card form (waits on the Basis Theory adapter) and transactional emails (no email sender yet; they should read `/v1/branding`).

1. **Platform accounts with sub-customers:** a platform creates and manages its own users' agents, cards and limits under one contract.
2. **White label:** the platform's name and logo on approvals, emails and the hosted card form.
3. **Revenue-share reporting:** volume and fees per platform and per aggregator, monthly statements.
4. **Partner kit:** SDK, sandbox keys, integration guide, MCP listing, and a certification checklist for platforms.
5. **Trust pack:** audit report, Basis Theory AOC, POPIA documents (`docs/legal/`).

## Risks
- The licence still sits somewhere: with VALR, the card issuer, or us. Platforms can't take it on for us.
- Platforms want exclusivity and low prices; keep a minimum monthly fee.
- One big platform can dominate revenue; aim for no customer above 30%.
