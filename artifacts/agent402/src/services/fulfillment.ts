/**
 * Fulfillment: dispatches a PAID, budget-tracked request to the real
 * SEARCH / READ / VERIFY services. Every external paid call inside the
 * services is authorized by the BudgetTracker BEFORE executing and recorded
 * in the CostLedger afterwards.
 *
 * The stub fulfiller remains for automated tests, which must never spend
 * real provider money.
 */

import type { Agent402Config } from "../config";
import type { CostLedger, CostCategory } from "../costs/ledger";
import type { BudgetTracker } from "../pricing/budget";
import type { ServiceName } from "../database/types";
import type { AIProvider } from "../providers";
import { OpenAIProvider } from "../providers/openai";
import { runRead } from "./read";
import { runSearch } from "./search";
import { runVerify } from "./verify";

export type FulfillFn = (
  service: ServiceName,
  body: unknown,
  budget: BudgetTracker,
  ledger: CostLedger,
) => Promise<unknown>;

/** Real fulfiller backed by the AI provider abstraction. */
export function createRealFulfiller(
  config: Agent402Config,
  provider: AIProvider = new OpenAIProvider(),
): FulfillFn {
  return async (service, body, budget, ledger) => {
    const ctx = { config, budget, ledger };
    switch (service) {
      case "search": {
        const { query } = body as { query: string };
        return runSearch(query, provider, ctx);
      }
      case "read": {
        const { url } = body as { url: string };
        return runRead(url, provider, ctx);
      }
      case "verify": {
        const { claim } = body as { claim: string };
        return runVerify(claim, provider, ctx);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Stub fulfiller (tests / demo only — no real provider calls, no real money).
// ---------------------------------------------------------------------------

export interface FulfillmentStep {
  category: CostCategory;
  cost: number;
  description: string;
}

export interface FulfillmentResult {
  service: ServiceName;
  demo: true;
  note: string;
  steps_executed: number;
  generated_at: string;
}

/** Simulated per-service step plans (mirror the real pipelines). */
export function defaultStepPlan(service: ServiceName): FulfillmentStep[] {
  switch (service) {
    case "search":
      return [
        { category: "search", cost: 0.004, description: "search provider call" },
        { category: "ai", cost: 0.003, description: "result ranking" },
      ];
    case "read":
      return [
        { category: "other", cost: 0.002, description: "content fetch" },
        { category: "ai", cost: 0.006, description: "extraction" },
      ];
    case "verify":
      return [
        { category: "search", cost: 0.004, description: "evidence search" },
        { category: "other", cost: 0.002, description: "source fetch" },
        { category: "ai", cost: 0.01, description: "evidence comparison" },
      ];
  }
}

/**
 * Run the stub fulfillment pipeline under a hard budget.
 * Throws BudgetExceededError from `budget.spend()` if any step would
 * exceed the remaining budget — the step is then NOT executed.
 */
export async function fulfill(
  service: ServiceName,
  budget: BudgetTracker,
  ledger: CostLedger,
  steps: FulfillmentStep[] = defaultStepPlan(service),
): Promise<FulfillmentResult> {
  let executed = 0;
  for (const step of steps) {
    // Authorize BEFORE doing the work. Throws BudgetExceededError if unsafe.
    budget.spend(step.cost, step.category);
    ledger.record(step.category, step.cost, `${step.description} (simulated)`);
    executed += 1;
  }
  return {
    service,
    demo: true,
    note: "TEST-MODE transaction — simulated fulfillment, no real provider calls or real money.",
    steps_executed: executed,
    generated_at: new Date().toISOString(),
  };
}
