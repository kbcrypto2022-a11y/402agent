import { describe, expect, it } from "vitest";
import { BudgetExceededError, BudgetTracker } from "../pricing/budget";
import { CostLedger } from "../costs/ledger";
import { fulfill } from "../services/fulfillment";

describe("BudgetTracker", () => {
  it("allows spending up to the limit", () => {
    const b = new BudgetTracker(0.02);
    b.spend(0.01, "ai");
    b.spend(0.01, "search");
    expect(b.spent).toBeCloseTo(0.02, 9);
    expect(b.remaining).toBeCloseTo(0, 9);
  });

  it("refuses a spend that would exceed the budget and records the refusal", () => {
    const b = new BudgetTracker(0.02);
    b.spend(0.015, "ai");
    expect(() => b.spend(0.01, "search")).toThrow(BudgetExceededError);
    expect(b.spent).toBeCloseTo(0.015, 9); // refused spend not added
    expect(b.events.at(-1)?.kind).toBe("refused");
  });

  it("retries cannot exceed the budget", () => {
    const b = new BudgetTracker(0.01);
    b.spend(0.006, "ai");
    // simulated retry of the same call
    expect(() => b.spend(0.006, "ai")).toThrow(BudgetExceededError);
  });
});

describe("fulfillment under hard budget", () => {
  it("halts before executing a step that would exceed the budget", async () => {
    const budget = new BudgetTracker(0.005);
    const ledger = new CostLedger("tx_test");
    await expect(
      fulfill("verify", budget, ledger, [
        { category: "search", cost: 0.004, description: "search" },
        { category: "ai", cost: 0.01, description: "expensive ai" },
      ]),
    ).rejects.toThrow(BudgetExceededError);
    // Only the first step's cost was incurred; the over-budget call never ran.
    expect(ledger.totals().totalCost).toBeCloseTo(0.004, 9);
    expect(budget.spent).toBeCloseTo(0.004, 9);
  });

  it("completes and records costs when within budget", async () => {
    const budget = new BudgetTracker(0.05);
    const ledger = new CostLedger("tx_test2");
    const result = await fulfill("search", budget, ledger);
    expect(result.steps_executed).toBe(2);
    expect(ledger.totals().totalCost).toBeGreaterThan(0);
  });
});

describe("CostLedger", () => {
  it("totals by category and computes gross profit/margin", () => {
    const ledger = new CostLedger("tx_x");
    ledger.record("ai", 0.006, "inference", { model: "test", retry: true });
    ledger.record("search", 0.004, "search call");
    ledger.record("other", 0.002, "fetch");
    const s = ledger.summarize(0.03);
    expect(s.aiCost).toBeCloseTo(0.006, 9);
    expect(s.searchCost).toBeCloseTo(0.004, 9);
    expect(s.otherCost).toBeCloseTo(0.002, 9);
    expect(s.totalCost).toBeCloseTo(0.012, 9);
    expect(s.grossProfit).toBeCloseTo(0.018, 9);
    expect(s.grossMargin).toBeCloseTo(0.6, 9);
    expect(s.retries).toBe(1);
  });
});
