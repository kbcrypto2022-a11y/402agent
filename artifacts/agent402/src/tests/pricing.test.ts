import { describe, expect, it } from "vitest";
import type { Agent402Config } from "../config";
import {
  applySafetyBuffer,
  buildQuote,
  fulfillmentBudgetFor,
  grossMargin,
  grossProfit,
  minimumPriceForMargin,
  UnprofitableRequestError,
} from "../pricing/engine";
import { roundUpToIncrement } from "../utils/money";

export function testConfig(
  overrides: Partial<Agent402Config> = {},
): Agent402Config {
  return {
    paymentMode: "test",
    minGrossMargin: 0.5,
    defaultTargetMargin: 0.6,
    costSafetyBuffer: 0.25,
    maxCostPerRequest: 0.1,
    maxAiCostPerRequest: 0.06,
    maxSearchCostPerRequest: 0.04,
    maxRetries: 2,
    priceRoundingIncrement: 0.001,
    paymentAsset: "USDC",
    paymentNetwork: "eip155:84532",
    recipientAddress: "0x0000000000000000000000000000000000000000",
    facilitatorUrl: "https://x402.org/facilitator",
    serviceCostEstimates: { search: 0.008, read: 0.01, verify: 0.024 },
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1000,
    ...overrides,
  };
}

describe("minimum price formula (gross margin, NOT markup)", () => {
  it("matches the spec example: cost 0.012 at 60% margin => 0.03", () => {
    expect(minimumPriceForMargin(0.012, 0.6)).toBeCloseTo(0.03, 9);
  });

  it("is price = C / (1 - M), not C * (1 + M)", () => {
    const price = minimumPriceForMargin(0.01, 0.6);
    expect(price).toBeCloseTo(0.025, 9);
    expect(price).not.toBeCloseTo(0.016, 3); // markup confusion would give 0.016
  });

  it("rejects margins >= 1 or < 0", () => {
    expect(() => minimumPriceForMargin(0.01, 1)).toThrow();
    expect(() => minimumPriceForMargin(0.01, -0.1)).toThrow();
  });
});

describe("gross profit / gross margin", () => {
  it("gross_profit = revenue - cost", () => {
    expect(grossProfit(0.05, 0.02)).toBeCloseTo(0.03, 9);
  });
  it("gross_margin = gross_profit / revenue", () => {
    expect(grossMargin(0.05, 0.02)).toBeCloseTo(0.6, 9);
  });
  it("zero revenue yields zero margin (no divide-by-zero)", () => {
    expect(grossMargin(0, 0.01)).toBe(0);
  });
});

describe("safety buffer", () => {
  it("budgeted cost = estimate * (1 + buffer)", () => {
    const c = testConfig({ costSafetyBuffer: 0.25 });
    expect(applySafetyBuffer(c, 0.01)).toBeCloseTo(0.0125, 9);
  });
});

describe("rounding", () => {
  it("rounds UP to the configured increment", () => {
    expect(roundUpToIncrement(0.0251, 0.001)).toBeCloseTo(0.026, 9);
    expect(roundUpToIncrement(0.025, 0.001)).toBeCloseTo(0.025, 9);
    expect(roundUpToIncrement(0.0301, 0.005)).toBeCloseTo(0.035, 9);
  });
});

describe("buildQuote profit protection", () => {
  it("quotes a price that respects the minimum margin even at full budget spend", () => {
    const c = testConfig();
    for (const service of ["search", "read", "verify"] as const) {
      const quote = buildQuote(c, service);
      const worstCase = grossMargin(quote.price, quote.budgetedCost);
      expect(worstCase).toBeGreaterThanOrEqual(c.minGrossMargin - 1e-9);
      expect(quote.price).toBeGreaterThan(quote.budgetedCost);
    }
  });

  it("prices off the budgeted (buffered) cost, not the optimistic estimate", () => {
    const c = testConfig({ costSafetyBuffer: 0.25, priceRoundingIncrement: 0.000001 });
    const quote = buildQuote(c, "read"); // estimate 0.01 -> budget 0.0125
    expect(quote.budgetedCost).toBeCloseTo(0.0125, 9);
    expect(quote.price).toBeCloseTo(0.0125 / 0.4, 6);
  });

  it("refuses requests whose budgeted cost exceeds MAX_COST_PER_REQUEST", () => {
    const c = testConfig({ maxCostPerRequest: 0.005 });
    expect(() => buildQuote(c, "verify")).toThrow(UnprofitableRequestError);
  });
});

describe("hard fulfillment budget", () => {
  it("budget = revenue * (1 - MIN_GROSS_MARGIN)", () => {
    const c = testConfig({ minGrossMargin: 0.6 });
    expect(fulfillmentBudgetFor(c, 0.05)).toBeCloseTo(0.02, 9);
  });
  it("is capped by MAX_COST_PER_REQUEST", () => {
    const c = testConfig({ minGrossMargin: 0.1, maxCostPerRequest: 0.03 });
    expect(fulfillmentBudgetFor(c, 1)).toBeCloseTo(0.03, 9);
  });
});
