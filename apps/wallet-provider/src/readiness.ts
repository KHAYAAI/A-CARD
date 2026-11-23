/**
 * What the provider insists on before it will touch a real network.
 * The code can check custody, screening and the Travel Rule. It cannot check
 * the audit, the licence or the ramp partner, so the operator must state each
 * one explicitly, with a reference, and the provider will not start without them.
 */
export function mainnetReadiness(s: {
  env: Record<string, string | undefined>;
  signer?: string;
  keySource: string;
  screening: boolean;
  travelRule: boolean;
  storeIsFile: boolean;
}): string[] {
  const p: string[] = [];
  if (s.signer !== "aws-kms") p.push("signing must happen inside AWS KMS (PROVIDER_SIGNER=aws-kms), so keys never leave it");
  if (s.keySource === "env") p.push("a plain PROVIDER_MASTER_KEY is not allowed on mainnet; use PROVIDER_MASTER_KEY_KMS_CIPHERTEXT or none");
  if (!s.screening) p.push("wallet screening must be on (PROVIDER_SCREENING=didit)");
  if (!s.travelRule) p.push("Travel Rule threshold must be set (PROVIDER_TRAVEL_RULE_USDC)");
  if (!s.storeIsFile) p.push("keys must be persisted (PROVIDER_STORE_FILE)");
  const ref = (k: string, what: string) => {
    if (!/^.{6,200}$/.test(s.env[k] ?? "")) p.push(`${what}: set ${k} to its reference (report id, licence number, contract id)`);
  };
  ref("PROVIDER_AUDIT_REF", "independent security audit");
  ref("PROVIDER_LICENCE_REF", "crypto-asset licence (FSCA CASP / VARA)");
  ref("PROVIDER_RAMP_PARTNER_REF", "rand on/off-ramp partner");
  return p;
}
