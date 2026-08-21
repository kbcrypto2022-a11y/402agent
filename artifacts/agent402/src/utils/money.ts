/**
 * Money helpers. Amounts are USD numbers; we normalize to micro-dollar
 * precision (6 decimal places) to avoid floating-point drift in ledger math.
 */

export const MONEY_DECIMALS = 6;
const FACTOR = 10 ** MONEY_DECIMALS;

/** Round to 6 decimal places (banker-safe for our magnitudes). */
export function roundMoney(amount: number): number {
  return Math.round(amount * FACTOR) / FACTOR;
}

/** Round UP to the nearest multiple of `increment` (e.g. 0.001). */
export function roundUpToIncrement(amount: number, increment: number): number {
  if (increment <= 0) throw new Error("increment must be > 0");
  const units = Math.ceil(roundMoney(amount) * FACTOR - 1e-9);
  const incUnits = Math.round(increment * FACTOR);
  const rounded = Math.ceil(units / incUnits) * incUnits;
  return rounded / FACTOR;
}

export function addMoney(...amounts: number[]): number {
  const totalUnits = amounts.reduce(
    (sum, a) => sum + Math.round(a * FACTOR),
    0,
  );
  return totalUnits / FACTOR;
}

/** Format for storage in numeric(…, 6) columns. */
export function moneyToString(amount: number): string {
  return roundMoney(amount).toFixed(MONEY_DECIMALS);
}
