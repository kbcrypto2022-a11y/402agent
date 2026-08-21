/**
 * Paid-call authorization helper: every external paid call must be
 * authorized by the BudgetTracker BEFORE executing, respecting both the
 * hard fulfillment budget and per-category cost caps, and its ACTUAL cost
 * recorded in the cost ledger afterwards.
 */

import type { Agent402Config } from "../config";
import type { CostCategory, CostLedger, CostEntry } from "../costs/ledger";
import { BudgetExceededError, type BudgetTracker } from "../pricing/budget";
import { ChargedCallError } from "../providers";

export interface SpendContext {
  config: Agent402Config;
  budget: BudgetTracker;
  ledger: CostLedger;
}

function categoryCap(config: Agent402Config, category: CostCategory): number {
  switch (category) {
    case "ai":
      return config.maxAiCostPerRequest;
    case "search":
      return config.maxSearchCostPerRequest;
    default:
      return config.maxCostPerRequest;
  }
}

/**
 * Authorize a paid call (worst-case estimate) BEFORE running it, run it,
 * then record its actual cost. Throws BudgetExceededError — without running
 * the call — when the estimate would blow the hard budget or a category cap.
 */
export async function paidCall<T>(
  ctx: SpendContext,
  category: CostCategory,
  estimate: number,
  description: string,
  run: () => Promise<{ value: T; actualCost: number; meta?: CostEntry["meta"] }>,
): Promise<T> {
  const spentInCategory = ctx.ledger
    .totals()
    [category === "ai" ? "aiCost" : category === "search" ? "searchCost" : "otherCost"];
  if (spentInCategory + estimate > categoryCap(ctx.config, category) + 1e-9) {
    throw new BudgetExceededError(estimate, spentInCategory, categoryCap(ctx.config, category));
  }
  // Hard budget authorization (throws BudgetExceededError when unsafe).
  ctx.budget.spend(estimate, category);
  let value: T;
  let actualCost: number;
  let meta: CostEntry["meta"] | undefined;
  try {
    ({ value, actualCost, meta } = await run());
  } catch (err) {
    // The call may have been CHARGED even though its output was unusable
    // (parse/validation failure after a successful provider response).
    // Record the actual charge and reconcile the budget BEFORE rethrowing,
    // so retries and margins account for every real charge.
    if (err instanceof ChargedCallError) {
      ctx.ledger.record(category, err.actualCost, `${description} (charged, output unusable)`, err.meta);
      if (err.actualCost > estimate) {
        ctx.budget.recordActualOverage(err.actualCost - estimate, category);
      }
    }
    throw err;
  }
  ctx.ledger.record(category, actualCost, description, meta);
  // Reconcile: if the actual charge exceeded the authorized estimate
  // (provider-side limits make this rare), charge the overage against the
  // budget so later authorizations see the true remaining amount.
  if (actualCost > estimate) {
    ctx.budget.recordActualOverage(actualCost - estimate, category);
  }
  return value;
}

/**
 * Retry wrapper honoring MAX_RETRIES. Each retry re-authorizes budget via
 * the wrapped paidCall, so retries can never create unlimited costs.
 */
export async function withRetries<T>(
  maxRetries: number,
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err; // never retry past budget
      lastErr = err;
    }
  }
  throw lastErr;
}
