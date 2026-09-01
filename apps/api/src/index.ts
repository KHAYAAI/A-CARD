import { serve } from "@hono/node-server";
import { Platform } from "@acard/core";
import { createApp } from "./app.js";
import { PostgresPersistence } from "./persistence.js";
import { InMemoryPlatformService, PostgresPlatformService, type PlatformService } from "./service/index.js";
import { attachSlackNotifications } from "./notifications.js";
import { InMemoryMerchantAuth, InMemoryMerchantDirectory, PostgresMerchantAuth, PostgresMerchantDirectory } from "./merchant/index.js";
import type { MerchantAuthPort, MerchantDirectoryPort } from "./merchant/types.js";
import { AfpLedger } from "@acard/core";
import { InMemoryAfpLedger, PostgresAfpLedger, type AfpLedgerPort } from "./afp/index.js";
import { createCardRail, createX402Rail, createStablecoinRail, createSandboxStablecoinClient, SANDBOX_SIGNER, type RailAdapter } from "./rails/index.js";

const port = Number(process.env.PORT ?? 8787);
const issuerWebhookSecret = process.env.ISSUER_WEBHOOK_SECRET ?? "whsec_sandbox_secret";
const databaseUrl = process.env.DATABASE_URL;
const dashboardUrl = process.env.DASHBOARD_URL;
const payfastMerchantId = process.env.PAYFAST_MERCHANT_ID;
const payfastMerchantKey = process.env.PAYFAST_MERCHANT_KEY;
const payfastPassphrase = process.env.PAYFAST_PASSPHRASE;
const payfastSandbox = process.env.PAYFAST_SANDBOX === "true";
const slackWebhookUrl = process.env.SLACK_APPROVALS_WEBHOOK_URL;
const workosApiKey = process.env.WORKOS_API_KEY;
const workosClientId = process.env.WORKOS_CLIENT_ID;
const kybDocumentsBucket = process.env.KYB_DOCUMENTS_BUCKET;
const awsRegion = process.env.AWS_REGION ?? "af-south-1";
const afpEnabled = process.env.ACARD_ENABLE_AFP === "true";
const afpX402PayerAddress = process.env.ACARD_AFP_X402_PAYER_ADDRESS;
const afpStablecoinFromAddress = process.env.ACARD_AFP_STABLECOIN_FROM_ADDRESS;

/**
 * Persistence modes:
 *   - no DATABASE_URL            → in-memory (ephemeral; sandbox/local dev)
 *   - DATABASE_URL (default)     → Postgres multi-writer store (row-level ledger,
 *                                  per-wallet row locks) — safe to run several API
 *                                  tasks against one database
 *   - DATABASE_URL + ACARD_PERSISTENCE=snapshot
 *                                → in-memory + single-writer JSONB snapshot
 *                                  (the earlier model; correct only at one instance)
 */
let platform: PlatformService;
let onMutation: (() => void) | undefined;
let onClose: (() => Promise<void>) | undefined;

if (!databaseUrl) {
  platform = new InMemoryPlatformService(new Platform());
  console.log("A-CARD API: no DATABASE_URL set — state is in-memory only and will not survive a restart");
} else if (process.env.ACARD_PERSISTENCE === "snapshot") {
  const persistence = new PostgresPersistence(databaseUrl);
  await persistence.migrate();
  const loaded = await persistence.load();
  platform = new InMemoryPlatformService(loaded);
  onMutation = () => persistence.save(loaded);
  onClose = () => persistence.close();
  console.log("A-CARD API: single-writer snapshot persistence (ACARD_PERSISTENCE=snapshot)");
} else {
  const pg = new PostgresPlatformService(databaseUrl);
  await pg.migrate();
  platform = pg;
  onClose = () => pg.close();
  console.log("A-CARD API: Postgres multi-writer store (row-level ledger with per-wallet locks)");
}

if (slackWebhookUrl) attachSlackNotifications(platform, slackWebhookUrl, dashboardUrl);

/**
 * A-MERCHANT gets its own backend choice, independent of which one A-CARD
 * itself is running — deliberately, so enabling A-MERCHANT never forces a
 * choice about A-CARD's own persistence:
 *
 *   - Postgres multi-writer (the default, `platform` above is a
 *     `PostgresPlatformService`) → the real, multi-writer merchant Postgres
 *     adapter, same database, its own tables and its own connection pool.
 *   - In-memory or single-writer snapshot → the in-memory directory, wrapped
 *     behind the same async port so app.ts never has to know the difference.
 */
let merchants: MerchantDirectoryPort;
let merchantAuth: MerchantAuthPort;

if (platform instanceof PostgresPlatformService) {
  const pgMerchants = new PostgresMerchantDirectory(databaseUrl as string);
  const pgMerchantAuth = new PostgresMerchantAuth(databaseUrl as string);
  await pgMerchants.migrate();
  merchants = pgMerchants;
  merchantAuth = pgMerchantAuth;
  const previousClose = onClose;
  onClose = async () => {
    await previousClose?.();
    await pgMerchants.close();
  };
  console.log("A-CARD API: A-MERCHANT on the Postgres multi-writer store — runs alongside A-CARD's own multi-instance ledger");
} else {
  const memoryPlatform = (platform as InMemoryPlatformService).platform;
  merchants = new InMemoryMerchantDirectory(memoryPlatform.merchants);
  merchantAuth = new InMemoryMerchantAuth(memoryPlatform.merchantAuth);
}

if (!workosApiKey) {
  console.log("A-CARD API: merchant portal disabled — set WORKOS_API_KEY/WORKOS_CLIENT_ID to let merchants log in and restate stock themselves");
}

/**
 * AFP (Agent Financial Platform) moves money across rails, so — unlike
 * A-MERCHANT's read-only catalog — it is never auto-wired just because a
 * database happens to be configured. It mounts only when an operator
 * explicitly sets ACARD_ENABLE_AFP=true; everything else here (which
 * ledger backend, which rails) follows from the same persistence choice
 * A-CARD and A-MERCHANT already made, once that flag is on.
 *
 * The card rail is the only rail included unconditionally when AFP is on —
 * it's a thin wrapper around A-CARD's own already-real authorization path,
 * no different in trust from /v1/simulate/purchase. x402 and stablecoin
 * are genuinely sandboxed (see apps/api/src/rails/x402.ts and
 * stablecoin.ts): no real signing key or custodied wallet exists yet, so
 * they only join the rail set when an operator supplies the address that
 * turns them on, and are logged loudly as sandbox-only when they do.
 */
let afp: { ledger: AfpLedgerPort; rails: RailAdapter[] } | undefined;

if (afpEnabled) {
  let afpLedger: AfpLedgerPort;
  if (platform instanceof PostgresPlatformService) {
    const pgLedger = new PostgresAfpLedger(databaseUrl as string);
    await pgLedger.migrate();
    afpLedger = pgLedger;
    const previousClose = onClose;
    onClose = async () => {
      await previousClose?.();
      await pgLedger.close();
    };
    console.log("A-CARD API: AFP enabled — ledger on the Postgres multi-writer store");
  } else {
    afpLedger = new InMemoryAfpLedger(new AfpLedger());
    console.log("A-CARD API: AFP enabled — ledger is in-memory only and will not survive a restart");
  }

  const rails: RailAdapter[] = [createCardRail(platform, issuerWebhookSecret)];

  if (afpX402PayerAddress) {
    rails.push(createX402Rail({ payerAddress: afpX402PayerAddress, signer: SANDBOX_SIGNER }));
    console.log("A-CARD API: AFP x402 rail enabled — SANDBOX_SIGNER only, produces syntactically valid but cryptographically meaningless signatures");
  }

  if (afpStablecoinFromAddress) {
    rails.push(
      createStablecoinRail({
        client: createSandboxStablecoinClient(),
        fromAddress: afpStablecoinFromAddress,
        resolveRecipient: (intent) => intent.counterparty,
      }),
    );
    console.log("A-CARD API: AFP stablecoin rail enabled — sandbox client only, no real chain settlement");
  }

  afp = { ledger: afpLedger, rails };
}

const app = createApp({
  platform,
  issuerWebhookSecret,
  dashboardUrl,
  onMutation,
  merchants,
  merchantAuth,
  afp,
  // AuthKit is a separate WorkOS product from the org-SSO `workos` config
  // below — same API key and project, but this logs an individual merchant
  // user in (password, magic link, WorkOS-hosted signup), where org SSO
  // instead federates an A-CARD organization to its own identity provider.
  // The callback lives on this API service for the same reason the SSO one
  // does — see the comment on `workos` below.
  merchantAuthKit:
    workosApiKey && workosClientId && dashboardUrl
      ? { apiKey: workosApiKey, clientId: workosClientId, redirectUri: `${dashboardUrl.replace(/\/$/, "")}/v1/merchant-auth/callback` }
      : undefined,
  // Real ZAR wallet funding AND subscription billing both route through
  // PayFast (see app.ts's /webhooks/payfast). Omit to keep /v1/wallet/fund's
  // instant sandbox credit and unmetered billing.
  payfast:
    payfastMerchantId && payfastMerchantKey && payfastPassphrase
      ? { merchantId: payfastMerchantId, merchantKey: payfastMerchantKey, passphrase: payfastPassphrase, sandbox: payfastSandbox }
      : undefined,
  // KYB registration document upload for the operator console (optional —
  // omit and merchant onboarding/verification still works, the upload
  // button just has nowhere to send a file). Bucket permissions come from
  // the task role in infra/cdk, not credentials in this process.
  kybDocuments: kybDocumentsBucket ? { bucket: kybDocumentsBucket, region: awsRegion } : undefined,
  // SSO is purely additive to password + MFA login — omit these three and the
  // deployment runs exactly as before, no code path changes. The callback
  // lives on this API service (see infra/cdk: the ALB only routes /v1/* here),
  // so the redirect URI is this same public origin, not the dashboard app.
  workos:
    workosApiKey && workosClientId && dashboardUrl
      ? { apiKey: workosApiKey, clientId: workosClientId, redirectUri: `${dashboardUrl.replace(/\/$/, "")}/v1/auth/sso/callback` }
      : undefined,
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`A-CARD API listening on http://localhost:${info.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.log(`A-CARD API: received ${signal}, flushing state and shutting down`);
    await onClose?.();
    server.close(() => process.exit(0));
  });
}
