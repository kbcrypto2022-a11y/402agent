/**
 * Benchmark metric computation (pure — unit-testable without any AI).
 *
 * "False verification" (declaring VERIFIED when the expected verdict is not
 * VERIFIED) is the most important failure mode: Agent402 must be
 * conservative about declaring something verified.
 */

import type { Verdict } from "../accuracy";
import { VERDICTS } from "../accuracy";

export interface BenchmarkItem {
  id: string;
  claim: string;
  expected_verdict: Verdict;
  reference_sources: string[];
  category: string;
  difficulty: "easy" | "medium" | "hard";
}

export interface BenchmarkOutcome {
  item: BenchmarkItem;
  actual_verdict: Verdict;
  confidence: number;
  source_count: number;
}

export interface BenchmarkMetrics {
  total: number;
  correct: number;
  verdict_accuracy: number;
  /** VERIFIED issued when expected != VERIFIED, over non-VERIFIED expectations. */
  false_verification_rate: number;
  /** NOT_VERIFIED issued when expected == VERIFIED, over VERIFIED expectations. */
  false_rejection_rate: number;
  insufficient_evidence_rate: number;
  conflicting_evidence_rate: number;
  average_confidence: number;
  verdict_distribution: Record<Verdict, number>;
  per_expected_verdict: Record<Verdict, { total: number; correct: number }>;
}

export function computeBenchmarkMetrics(
  outcomes: BenchmarkOutcome[],
): BenchmarkMetrics {
  const total = outcomes.length;
  const distribution = Object.fromEntries(
    VERDICTS.map((v) => [v, 0]),
  ) as Record<Verdict, number>;
  const perExpected = Object.fromEntries(
    VERDICTS.map((v) => [v, { total: 0, correct: 0 }]),
  ) as Record<Verdict, { total: number; correct: number }>;

  let correct = 0;
  let falseVerifications = 0;
  let nonVerifiedExpected = 0;
  let falseRejections = 0;
  let verifiedExpected = 0;
  let confidenceSum = 0;

  for (const o of outcomes) {
    distribution[o.actual_verdict] += 1;
    perExpected[o.item.expected_verdict].total += 1;
    confidenceSum += o.confidence;
    if (o.actual_verdict === o.item.expected_verdict) {
      correct += 1;
      perExpected[o.item.expected_verdict].correct += 1;
    }
    if (o.item.expected_verdict !== "VERIFIED") {
      nonVerifiedExpected += 1;
      if (o.actual_verdict === "VERIFIED") falseVerifications += 1;
    } else {
      verifiedExpected += 1;
      if (o.actual_verdict === "NOT_VERIFIED") falseRejections += 1;
    }
  }

  return {
    total,
    correct,
    verdict_accuracy: total === 0 ? 0 : correct / total,
    false_verification_rate:
      nonVerifiedExpected === 0 ? 0 : falseVerifications / nonVerifiedExpected,
    false_rejection_rate:
      verifiedExpected === 0 ? 0 : falseRejections / verifiedExpected,
    insufficient_evidence_rate:
      total === 0 ? 0 : distribution.INSUFFICIENT_EVIDENCE / total,
    conflicting_evidence_rate:
      total === 0 ? 0 : distribution.CONFLICTING_EVIDENCE / total,
    average_confidence: total === 0 ? 0 : confidenceSum / total,
    verdict_distribution: distribution,
    per_expected_verdict: perExpected,
  };
}
