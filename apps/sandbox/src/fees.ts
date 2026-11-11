/**
 * Illustrative sandbox fee schedule. A-CARD has no card-payment pricing yet, so
 * these are placeholders: change them here (and `FEES` in public/index.html,
 * which the cart uses to show the same numbers). They are charged for real in
 * the sandbox ledger, as a separate payment to "a·card fees" (category 7399).
 */
export const FEES = { orderCents: 1500, processingBps: 290, mcc: "7399" };
export const feeFor = (itemsCents: number) => {
  const processing = Math.round((itemsCents * FEES.processingBps) / 10000);
  return { order: FEES.orderCents, processing, total: FEES.orderCents + processing };
};
