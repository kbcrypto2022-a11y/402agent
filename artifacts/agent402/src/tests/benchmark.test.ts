import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERDICTS } from "../accuracy";
import {
  computeBenchmarkMetrics,
  type BenchmarkItem,
  type BenchmarkOutcome,
} from "../evals/metrics";

const here = dirname(fileURLToPath(import.meta.url));

const item = (id: string, expected: BenchmarkItem["expected_verdict"]): BenchmarkItem => ({
  id,
  claim: `claim ${id}`,
  expected_verdict: expected,
  reference_sources: [],
  category: "test",
  difficulty: "easy",
});

const outcome = (
  expected: BenchmarkItem["expected_verdict"],
  actual: BenchmarkOutcome["actual_verdict"],
  confidence = 0.5,
): BenchmarkOutcome => ({
  item: item(`${expected}->${actual}`, expected),
  actual_verdict: actual,
  confidence,
  source_count: 2,
});

describe("benchmark claim set", () => {
  it("contains well-formed items covering all four verdicts", () => {
    const { items } = JSON.parse(
      readFileSync(join(here, "../evals/claims.json"), "utf-8"),
    ) as { items: BenchmarkItem[] };
    expect(items.length).toBeGreaterThanOrEqual(8);
    for (const it of items) {
      expect(it.claim.length).toBeGreaterThan(5);
      expect(VERDICTS).toContain(it.expected_verdict);
      expect(["easy", "medium", "hard"]).toContain(it.difficulty);
      expect(Array.isArray(it.reference_sources)).toBe(true);
    }
    const expectedSet = new Set(items.map((i) => i.expected_verdict));
    for (const v of VERDICTS) expect(expectedSet.has(v)).toBe(true);
  });
});

describe("benchmark metrics", () => {
  it("computes verdict accuracy and distribution", () => {
    const m = computeBenchmarkMetrics([
      outcome("VERIFIED", "VERIFIED", 0.9),
      outcome("NOT_VERIFIED", "NOT_VERIFIED", 0.3),
      outcome("INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", 0.2),
      outcome("CONFLICTING_EVIDENCE", "INSUFFICIENT_EVIDENCE", 0.4),
    ]);
    expect(m.total).toBe(4);
    expect(m.correct).toBe(3);
    expect(m.verdict_accuracy).toBeCloseTo(0.75);
    expect(m.insufficient_evidence_rate).toBeCloseTo(0.5);
    expect(m.verdict_distribution.VERIFIED).toBe(1);
  });

  it("measures false verification rate (the critical failure mode)", () => {
    const m = computeBenchmarkMetrics([
      outcome("NOT_VERIFIED", "VERIFIED", 0.8), // false verification!
      outcome("NOT_VERIFIED", "NOT_VERIFIED", 0.2),
      outcome("INSUFFICIENT_EVIDENCE", "INSUFFICIENT_EVIDENCE", 0.1),
      outcome("VERIFIED", "VERIFIED", 0.9),
    ]);
    expect(m.false_verification_rate).toBeCloseTo(1 / 3);
    expect(m.false_rejection_rate).toBe(0);
  });

  it("measures false rejection rate", () => {
    const m = computeBenchmarkMetrics([
      outcome("VERIFIED", "NOT_VERIFIED", 0.2),
      outcome("VERIFIED", "VERIFIED", 0.9),
    ]);
    expect(m.false_rejection_rate).toBeCloseTo(0.5);
  });

  it("handles the empty set without dividing by zero", () => {
    const m = computeBenchmarkMetrics([]);
    expect(m.verdict_accuracy).toBe(0);
    expect(m.false_verification_rate).toBe(0);
    expect(m.average_confidence).toBe(0);
  });
});
