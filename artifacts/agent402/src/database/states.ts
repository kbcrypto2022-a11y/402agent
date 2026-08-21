/** Explicit transaction state machine. */

export const TRANSACTION_STATES = [
  "REQUESTED",
  "QUOTED",
  "PAYMENT_REQUIRED",
  "PAYMENT_VERIFIED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "BUDGET_EXCEEDED",
  "REFUND_REVIEW",
] as const;

export type TransactionState = (typeof TRANSACTION_STATES)[number];

/** Allowed transitions. A transaction may only move along these edges. */
const TRANSITIONS: Record<TransactionState, readonly TransactionState[]> = {
  REQUESTED: ["QUOTED", "FAILED"],
  QUOTED: ["PAYMENT_REQUIRED", "FAILED"],
  PAYMENT_REQUIRED: ["PAYMENT_VERIFIED", "FAILED"],
  PAYMENT_VERIFIED: ["PROCESSING", "FAILED", "REFUND_REVIEW"],
  PROCESSING: ["COMPLETED", "FAILED", "BUDGET_EXCEEDED"],
  COMPLETED: [],
  FAILED: [],
  BUDGET_EXCEEDED: ["REFUND_REVIEW"],
  REFUND_REVIEW: [],
};

export function canTransition(
  from: TransactionState,
  to: TransactionState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TransactionState,
    public readonly to: TransactionState,
  ) {
    super(`Invalid transaction state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(
  from: TransactionState,
  to: TransactionState,
): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
