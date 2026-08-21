import { addMoney, roundMoney } from "../utils/money";
import { grossMargin, grossProfit } from "../pricing/engine";

export type CostCategory = "ai" | "search" | "other" | "payment";

export interface CostEntry {
  at: Date;
  category: CostCategory;
  amount: number;
  description: string;
  /** AI-specific telemetry, when applicable. */
  meta?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    provider?: string;
    retry?: boolean;
  };
}

export interface CostTotals {
  aiCost: number;
  searchCost: number;
  otherCost: number;
  paymentCost: number;
  totalCost: number;
  retries: number;
}

export interface ProfitSummary extends CostTotals {
  revenue: number;
  grossProfit: number;
  grossMargin: number;
}

/**
 * Central per-transaction cost ledger. Every external paid operation must
 * record its (estimated or actual) cost here so gross profit and gross
 * margin can be computed per transaction.
 */
export class CostLedger {
  readonly entries: CostEntry[] = [];

  constructor(readonly transactionId: string) {}

  record(
    category: CostCategory,
    amount: number,
    description: string,
    meta?: CostEntry["meta"],
  ): void {
    if (amount < 0) throw new Error("Cost amount must be >= 0");
    const entry: CostEntry = {
      at: new Date(),
      category,
      amount: roundMoney(amount),
      description,
    };
    if (meta !== undefined) entry.meta = meta;
    this.entries.push(entry);
  }

  totals(): CostTotals {
    const sum = (cat: CostCategory) =>
      addMoney(
        0,
        ...this.entries.filter((e) => e.category === cat).map((e) => e.amount),
      );
    const aiCost = sum("ai");
    const searchCost = sum("search");
    const otherCost = sum("other");
    const paymentCost = sum("payment");
    return {
      aiCost,
      searchCost,
      otherCost,
      paymentCost,
      totalCost: addMoney(aiCost, searchCost, otherCost, paymentCost),
      retries: this.entries.filter((e) => e.meta?.retry === true).length,
    };
  }

  /** gross_profit = revenue - total_cost; gross_margin = gross_profit / revenue */
  summarize(revenue: number): ProfitSummary {
    const totals = this.totals();
    return {
      ...totals,
      revenue,
      grossProfit: grossProfit(revenue, totals.totalCost),
      grossMargin: grossMargin(revenue, totals.totalCost),
    };
  }
}
