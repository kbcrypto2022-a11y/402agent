import type { Agent402Config } from "../config";
import type { ServiceName } from "../database/types";
import { roundMoney, roundUpToIncrement } from "../utils/money";

export class UnprofitableRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string = "UNPROFITABLE_REQUEST",
  ) {
    super(message);
    this.name = "UnprofitableRequestError";
  }
}

export interface Quote {
  service: ServiceName;
  /** Optimistic cost estimate (USD). */
  estimatedCost: number;
  /** Estimate with contingency buffer applied. Used for pricing & budget. */
  budgetedCost: number;
  /** Target gross margin used for pricing (0–1). */
  targetMargin: number;
  /** Final quoted selling price (USD), rounded up. */
  price: number;
}

/** Estimate fulfillment cost for a service before doing any paid work. */
export function estimateCost(
  config: Agent402Config,
  service: ServiceName,
): number {
  const estimate = config.serviceCostEstimates[service];
  if (estimate === undefined || estimate < 0) {
    throw new Error(`No cost estimate configured for service: ${service}`);
  }
  return estimate;
}

/** budgeted_cost = estimated_cost * (1 + safety_buffer) */
export function applySafetyBuffer(
  config: Agent402Config,
  estimatedCost: number,
): number {
  return roundMoney(estimatedCost * (1 + config.costSafetyBuffer));
}

/**
 * minimum_price = budgeted_cost / (1 - margin)
 *
 * GROSS MARGIN, not markup: margin is profit as a fraction of PRICE.
 * (cost * (1 + margin) would be markup — never use that here.)
 */
export function minimumPriceForMargin(cost: number, margin: number): number {
  if (margin < 0 || margin >= 1) {
    throw new Error(`Margin must be in [0, 1): got ${margin}`);
  }
  if (cost < 0) throw new Error("Cost must be >= 0");
  return roundMoney(cost / (1 - margin));
}

/** Realized gross margin of a completed transaction. */
export function grossMargin(revenue: number, totalCost: number): number {
  if (revenue <= 0) return 0;
  return (revenue - totalCost) / revenue;
}

export function grossProfit(revenue: number, totalCost: number): number {
  return roundMoney(revenue - totalCost);
}

/**
 * Build a full quote for a service request, enforcing all profit-protection
 * rules. Throws UnprofitableRequestError when the request cannot be served
 * within configured cost caps.
 */
export function buildQuote(
  config: Agent402Config,
  service: ServiceName,
): Quote {
  const estimatedCost = estimateCost(config, service);
  const budgetedCost = applySafetyBuffer(config, estimatedCost);

  if (budgetedCost > config.maxCostPerRequest) {
    throw new UnprofitableRequestError(
      `Budgeted cost ${budgetedCost} exceeds MAX_COST_PER_REQUEST ${config.maxCostPerRequest}`,
      "COST_CAP_EXCEEDED",
    );
  }

  const targetMargin = Math.max(
    config.defaultTargetMargin,
    config.minGrossMargin,
  );
  const rawPrice = minimumPriceForMargin(budgetedCost, targetMargin);
  const price = roundUpToIncrement(rawPrice, config.priceRoundingIncrement);

  // Invariant: the rounded price must still satisfy the minimum margin
  // even if the whole budgeted cost is spent.
  const worstCaseMargin = grossMargin(price, budgetedCost);
  if (worstCaseMargin < config.minGrossMargin - 1e-9) {
    throw new UnprofitableRequestError(
      `Quoted price ${price} yields worst-case margin ${worstCaseMargin.toFixed(4)} < MIN_GROSS_MARGIN ${config.minGrossMargin}`,
      "MARGIN_VIOLATION",
    );
  }

  return { service, estimatedCost, budgetedCost, targetMargin, price };
}

/**
 * Hard fulfillment budget once the customer has paid:
 * max_spend = revenue * (1 - MIN_GROSS_MARGIN), capped by MAX_COST_PER_REQUEST.
 */
export function fulfillmentBudgetFor(
  config: Agent402Config,
  revenue: number,
): number {
  return roundMoney(
    Math.min(revenue * (1 - config.minGrossMargin), config.maxCostPerRequest),
  );
}
