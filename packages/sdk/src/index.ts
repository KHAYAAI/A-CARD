export { Acard, type AcardOptions } from "./client.js";
export { AcardMerchant, type AcardMerchantOptions, type CatalogSyncItem } from "./merchant.js";
export { AcardError, ApprovalTimeoutError } from "./errors.js";
export {
  verifyMerchantWebhook,
  verifyIssuerWebhook,
  signAcardWebhook,
  type MerchantEvent,
  type VerifyResult,
  type VerifyFailure,
  type VerifyOptions,
} from "./webhooks.js";
export * from "./types.js";

/** True when a purchase was held for a human, i.e. worth waiting on rather than abandoning. */
export function isAwaitingApproval(result: { approved: boolean; decline_reason?: string }): boolean {
  return !result.approved && result.decline_reason === "pending_human_approval";
}
