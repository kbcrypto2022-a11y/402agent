/**
 * Benchmark runner: executes the VERIFY pipeline against the known-verdict
 * claim set and reports accuracy metrics.
 *
 * NOTE: this spends REAL provider money (web search + AI calls) — it is a
 * manual/eval tool, not part of the automated test suite.
 *
 *   pnpm --filter @workspace/agent402 run eval           # full set
 *   pnpm --filter @workspace/agent402 run eval geo-001   # single item
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getConfig } from "../config";
import { CostLedger } from "../costs/ledger";
import { BudgetTracker } from "../pricing/budget";
import { fulfillmentBudgetFor, buildQuote } from "../pricing/engine";
import { OpenAIProvider } from "../providers/openai";
import { runVerify } from "../services/verify";
import {
  computeBenchmarkMetrics,
  type BenchmarkItem,
  type BenchmarkOutcome,
} from "./metrics";

const here = dirname(fileURLToPath(import.meta.url));
const claimsPath = join(here, "claims.json");

async function main() {
  const { items } = JSON.parse(readFileSync(claimsPath, "utf-8")) as {
    items: BenchmarkItem[];
  };
  const only = process.argv[2];
  const selected = only ? items.filter((i) => i.id === only) : items;
  if (selected.length === 0) {
    console.error(`No benchmark items matched "${only}"`);
    process.exit(1);
  }

  const config = getConfig();
  const provider = new OpenAIProvider();
  const quote = buildQuote(config, "verify");
  const outcomes: BenchmarkOutcome[] = [];
  let totalCost = 0;

  for (const item of selected) {
    const budget = new BudgetTracker(fulfillmentBudgetFor(config, quote.price));
    const ledger = new CostLedger(`eval_${item.id}`);
    process.stdout.write(`[${item.id}] ${item.claim}\n`);
    try {
      const res = await runVerify(item.claim, provider, { config, budget, ledger });
      const cost = ledger.totals().totalCost;
      totalCost += cost;
      outcomes.push({
        item,
        actual_verdict: res.verdict,
        confidence: res.confidence,
        source_count: res.source_count,
      });
      const ok = res.verdict === item.expected_verdict ? "OK " : "MISS";
      console.log(
        `  ${ok} expected=${item.expected_verdict} actual=${res.verdict} confidence=${res.confidence} sources=${res.source_count} cost=$${cost.toFixed(4)}`,
      );
    } catch (err) {
      console.log(`  ERROR ${err instanceof Error ? err.message : String(err)}`);
      outcomes.push({
        item,
        actual_verdict: "INSUFFICIENT_EVIDENCE",
        confidence: 0,
        source_count: 0,
      });
    }
  }

  const metrics = computeBenchmarkMetrics(outcomes);
  console.log("\n===== BENCHMARK METRICS =====");
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Total eval spend: $${totalCost.toFixed(4)}`);
  if (metrics.false_verification_rate > 0) {
    console.log(
      "WARNING: false verifications occurred — Agent402 must stay conservative about VERIFIED.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
