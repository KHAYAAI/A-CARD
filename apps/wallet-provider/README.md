# @acard/wallet-provider

A self-hostable **embedded-wallet provider** for A-CARD. It generates real keys, stores them encrypted, derives real addresses, reads USDC balances, and signs and sends **testnet** USDC transfers on EVM chains.

> **Status: not audited. Test networks by default.** Do not point this at funds you cannot afford to lose. Holding real money needs, at minimum, a KMS/HSM-backed master key, an independent security review, and the legal position in the platform README. Mainnet is refused unless an operator explicitly sets `PROVIDER_ALLOW_MAINNET=true`.

## What it does

| | |
|---|---|
| `POST /wallets` `{userId, chain}` | Idempotent per user and chain. Returns `{address, chain}`. Never returns key material. |
| `GET /wallets/balance?chain&address` | USDC balance from the chain (`raw` in base units, `balance` in USDC). |
| `POST /wallets/transfer` | `{chain, from, to, amount, idempotencyKey}`; `amount` is USDC base units (6 decimals). Signs with the wallet's own key and broadcasts. |
| `GET /status` | Networks, whether each is a testnet, and the limits. The platform reads this to decide whether the rail "carries real value". |
| `GET /healthz` | Unauthenticated liveness. |

All other routes need `Authorization: Bearer $PROVIDER_API_KEY` (constant-time comparison). This is exactly what the API's `EmbeddedWalletClient` already speaks.

**Chains.** Ethereum (Sepolia by default) and Polygon (Amoy): keys, addresses, balances and transfers. Solana (devnet): keys, addresses and balances only. **Solana transfers return 501.**

## How keys are protected

- Each key is generated with the platform CSPRNG (secp256k1 via viem, ed25519 via noble).
- At rest it is sealed with **AES-256-GCM** under a per-record key derived from `PROVIDER_MASTER_KEY` with HKDF-SHA256 and a random salt. The `userId|chain|address` is bound as AAD, so a sealed key moved to another record will not open.
- A key is opened only for the signing call and zeroed afterwards. There is no export endpoint.
- The file store is written atomically with mode `0600` and the provider refuses to open it if other users can read it.
- Logs are JSON audit lines (ids, addresses, amounts, hashes). No key material, ever.

**Limits of this design.** The master key sits in process memory and in an environment variable. Anyone who can read both the store file and that variable can spend every wallet. That is acceptable for testnet; for real funds replace `crypto.ts` with a KMS/HSM envelope (the `seal`/`open` seam is small on purpose) or a threshold signer.

## Safety switches

- **Testnet gate.** `loadNetworks` throws at startup for any non-testnet network unless `PROVIDER_ALLOW_MAINNET=true`.
- **Caps.** `PROVIDER_MAX_TRANSFER_USDC` (default 100) per transfer and `PROVIDER_MAX_DAILY_USDC` (default 250) per wallet per rolling 24h, checked before the key is opened.
- **Ownership.** It only sends from wallets it created.
- **Idempotency.** The same key replays the same result and never pays twice; reusing a key for a different transfer is a 409. Transfers from one wallet are serialised so nonces cannot collide.
- **Honest outcomes.** A broadcast with no receipt in time returns `confirmed:false`, which the platform rail treats as *unknown* (reconciling), not failed.
- **Stays off in the platform** until `ACARD_WALLET_PROVIDER_URL` is set on the API.

## Run it

```bash
export PROVIDER_API_KEY=$(openssl rand -hex 24)
export PROVIDER_MASTER_KEY=$(openssl rand -hex 32)      # keep it out of the repo and shell history
export PROVIDER_STORE_FILE=/var/lib/provider/keys.json   # or PROVIDER_ALLOW_EPHEMERAL=true for a throwaway run
export PROVIDER_RPC_ETHEREUM=https://<a Sepolia RPC>     # optional: balances and transfers need it
npm run -w @acard/wallet-provider start                  # listens on :8788
```

Then on the API: `ACARD_ENABLE_AFP=true ACARD_WALLET_PROVIDER_URL=http://localhost:8788 ACARD_WALLET_PROVIDER_KEY=<PROVIDER_API_KEY>`. New signups get a real embedded wallet, and USD stablecoin intents execute as signed testnet USDC transfers from it. Fund an address from a testnet faucet (Circle's USDC faucet) to try it.

Other env: `PROVIDER_RPC_POLYGON`, `PROVIDER_RPC_SOLANA`, `PROVIDER_NETWORKS_JSON` (replace the default networks, e.g. Base Sepolia), `PORT`.

## What is and isn't tested

Tested here (`npm test -w @acard/wallet-provider`, and `apps/api/test/wallet-provider.test.ts` end to end): key generation and known address vectors, encryption round trip, tamper/wrong-key/moved-record failures, idempotent creation, auth, file permissions, caps, nonce serialisation, idempotent replay, and a full platform signup → intent → execute flow. The chain in those tests is a **fake JSON-RPC node** (`./testing`) that independently decodes the signed transaction, recovers the signer from the signature, and enforces chain id, nonce and balance.

**Not tested here:** a real RPC endpoint, the real Sepolia/Amoy/devnet USDC contracts, gas behaviour on a live network, or any audit. This environment cannot reach chain nodes. Run a transfer on Sepolia with faucet funds before relying on it.
