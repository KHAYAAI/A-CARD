/**
 * Money is always represented as an integer amount of the currency's minor
 * unit (cents). Floating point never touches a balance.
 */
export type Currency = "ZAR" | "USD" | "NGN" | "KES";

export interface Money {
  amount: number; // minor units (cents), always an integer >= 0 in APIs
  currency: Currency;
}

export function money(amount: number, currency: Currency): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`money amount must be an integer of minor units, got ${amount}`);
  }
  return { amount, currency };
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function formatMoney(m: Money): string {
  const major = (m.amount / 100).toFixed(2);
  return `${m.currency} ${major}`;
}
