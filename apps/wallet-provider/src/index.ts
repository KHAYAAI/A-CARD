import { serve } from "@hono/node-server";
import { createProviderApp } from "./app.js";
import { loadNetworks } from "./chains.js";
import { loadMasterKey } from "./kms.js";
import { DiditScreener } from "./screening.js";
import { awsKmsSigner } from "./kmsSigner.js";
import { ProviderService, usdc } from "./service.js";
import { FileKeyStore, MemoryKeyStore } from "./store.js";
import { mainnetReadiness } from "./readiness.js";

const env = process.env;
const fail = (m: string): never => {
  console.error(`wallet-provider: ${m}`);
  process.exit(1);
};

const apiKey = env.PROVIDER_API_KEY ?? fail("PROVIDER_API_KEY is required (at least 24 characters)");
if (apiKey.length < 24) fail("PROVIDER_API_KEY must be at least 24 characters");
const signer = env.PROVIDER_SIGNER === "aws-kms" ? awsKmsSigner(env.PROVIDER_KMS_REGION) : env.PROVIDER_SIGNER ? fail("PROVIDER_SIGNER must be aws-kms or unset") : undefined;
const hasLocalKey = Boolean(env.PROVIDER_MASTER_KEY || env.PROVIDER_MASTER_KEY_KMS_CIPHERTEXT);
// With KMS signing the master key is optional: it is only needed to keep using wallets made before the switch.
const { key: masterKey, source: keySource } = signer && !hasLocalKey ? { key: undefined, source: "none" as const } : await loadMasterKey(env).catch((e: Error) => fail(e.message));

let store;
if (env.PROVIDER_STORE_FILE) store = new FileKeyStore(env.PROVIDER_STORE_FILE);
else if (env.PROVIDER_ALLOW_EPHEMERAL === "true") store = new MemoryKeyStore();
else fail("set PROVIDER_STORE_FILE (keys must survive a restart) or PROVIDER_ALLOW_EPHEMERAL=true for a throwaway run");

const networks = loadNetworks(env);
const screener = env.PROVIDER_SCREENING === "didit" ? new DiditScreener(env.DIDIT_API_KEY ?? fail("DIDIT_API_KEY is required with PROVIDER_SCREENING=didit"), env.DIDIT_BASE_URL) : undefined;
const threshold = env.PROVIDER_TRAVEL_RULE_USDC ? usdc(Number(env.PROVIDER_TRAVEL_RULE_USDC)) : undefined;

const problems = mainnetReadiness({ env, signer: signer?.name, keySource, screening: Boolean(screener), travelRule: threshold !== undefined, storeIsFile: Boolean(env.PROVIDER_STORE_FILE) });
if (env.PROVIDER_ALLOW_MAINNET === "true" && problems.length) fail(`mainnet refused:\n  - ${problems.join("\n  - ")}`);

const svc = new ProviderService({
  masterKey,
  keySource: keySource === "none" ? undefined : keySource,
  signer,
  store: store!,
  networks,
  maxTransfer: usdc(Number(env.PROVIDER_MAX_TRANSFER_USDC ?? 100)),
  maxDaily: usdc(Number(env.PROVIDER_MAX_DAILY_USDC ?? 250)),
  compliance: { screener, travelRuleThreshold: threshold },
});
const port = Number(env.PORT ?? 8788);
serve({ fetch: createProviderApp(svc, { apiKey }).fetch, port });
console.error(`wallet-provider listening on :${port} (${svc.status().testnet ? "TEST NETWORKS ONLY" : "MAINNET ENABLED"}; signing: ${signer ? signer.name + " (keys never leave)" : "local key, master from " + keySource}; screening: ${screener?.name ?? "off"}; travel rule: ${threshold === undefined ? "off" : env.PROVIDER_TRAVEL_RULE_USDC + " USDC"})`);
