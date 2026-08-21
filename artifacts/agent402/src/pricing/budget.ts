import { addMoney, roundMoney } from "../utils/money";

export class BudgetExceededError extends Error {
  constructor(
    public readonly attempted: number,
    public readonly spent: number,
    public readonly limit: number,
  ) {
    super(
      `Budget exceeded: attempted spend ${attempted} with ${roundMoney(limit - spent)} remaining of ${limit}`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface BudgetEvent {
  at: Date;
  kind: "spend" | "refused";
  category: string;
  amount: number;
  spentAfter: number;
}

/**
 * Hard fulfillment budget tracker. Every external paid call must be
 * authorized through `spend()` BEFORE the call is made. A call whose
 * worst-case cost would exceed the remaining budget is refused — it throws
 * BudgetExceededError and logs a `refused` event; the caller must stop work.
 */
export class BudgetTracker {
  private spentTotal = 0;
  readonly events: BudgetEvent[] = [];

  constructor(readonly limit: number) {
    if (limit < 0) throw new Error("Budget limit must be >= 0");
  }

  get spent(): number {
    return this.spentTotal;
  }

  get remaining(): number {
    return roundMoney(this.limit - this.spentTotal);
  }

  /** Would spending `amount` stay within budget? (No side effects.) */
  canSpend(amount: number): boolean {
    return addMoney(this.spentTotal, amount) <= this.limit + 1e-9;
  }

  /**
   * Authorize and record a spend. Throws BudgetExceededError (and records a
   * refusal event) if the spend would exceed the hard budget.
   */
  spend(amount: number, category: string): void {
    if (amount < 0) throw new Error("Spend amount must be >= 0");
    if (!this.canSpend(amount)) {
      this.events.push({
        at: new Date(),
        kind: "refused",
        category,
        amount,
        spentAfter: this.spentTotal,
      });
      throw new BudgetExceededError(amount, this.spentTotal, this.limit);
    }
    this.spentTotal = addMoney(this.spentTotal, amount);
    this.events.push({
      at: new Date(),
      kind: "spend",
      category,
      amount,
      spentAfter: this.spentTotal,
    });
  }

  /**
   * Record cost that has ALREADY been incurred (e.g. an actual provider
   * charge that came in above its authorized estimate). Never throws —
   * the money is already spent — but reduces the remaining budget so
   * subsequent authorizations see the true position.
   */
  recordActualOverage(amount: number, category: string): void {
    if (amount <= 0) return;
    this.spentTotal = addMoney(this.spentTotal, amount);
    this.events.push({
      at: new Date(),
      kind: "spend",
      category: `${category}:overage`,
      amount,
      spentAfter: this.spentTotal,
    });
  }
}
