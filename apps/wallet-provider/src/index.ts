import { serve } from "@hono/node-server";
import { createProviderApp } from "./app.js";
import { loadNetworks } from "./chains.js";
import { parseMasterKey } from "./crypto.js";
import { ProviderService, usdc } from "./service.js";
import { FileKeyStore, MemoryKeyStore } from "./store.js";

const env = process.env;
const fail = (m: string): never => {
  console.error(`wallet-provider: ${m}`);
  process.exit(1);
};

const apiKey = env.PROVIDER_API_KEY ?? fail("PROVIDER_API_KEY is required (at least 24 characters)");
if (apiKey.length < 24) fail("PROVIDER_API_KEY must be at least 24 characters");
const masterKey = parseMasterKey(env.PROVIDER_MASTER_KEY ?? fail("PROVIDER_MASTER_KEY is required: 32 random bytes as 64 hex characters or base64"));

let store;
if (env.PROVIDER_STORE_FILE) store = new FileKeyStore(env.PROVIDER_STORE_FILE);
else if (env.PROVIDER_ALLOW_EPHEMERAL === "true") store = new MemoryKeyStore();
else fail("set PROVIDER_STORE_FILE (keys must survive a restart) or PROVIDER_ALLOW_EPHEMERAL=true for a throwaway run");

const networks = loadNetworks(env);
const svc = new ProviderService({
  masterKey,
  store: store!,
  networks,
  maxTransfer: usdc(Number(env.PROVIDER_MAX_TRANSFER_USDC ?? 100)),
  maxDaily: usdc(Number(env.PROVIDER_MAX_DAILY_USDC ?? 250)),
});
const port = Number(env.PORT ?? 8788);
serve({ fetch: createProviderApp(svc, { apiKey }).fetch, port });
console.error(`wallet-provider listening on :${port} (${svc.status().testnet ? "TEST NETWORKS ONLY" : "MAINNET ENABLED"})`);
