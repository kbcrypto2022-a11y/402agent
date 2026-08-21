/**
 * Transparent multi-signal confidence calculation (0.00–1.00).
 *
 * Confidence is computed from MEASURABLE signals — never the model's
 * subjective feeling — and the component scores are stored alongside the
 * final number. Confidence is NOT measured accuracy and must never be
 * presented as "% factual accuracy"; accuracy is measured separately by the
 * benchmark suite.
 */

import type { SourceTier } from "./index";
import { tierScore } from "./tiering";

export interface ConfidenceInput {
  primarySourceFound: boolean;
  /** Independent origins that SUPPORT the claim (same-origin deduped). */
  independentSupportingSources: number;
  /** Independent origins that CONTRADICT the claim. */
  independentContradictingSources: number;
  /** Tiers of all sources actually used as evidence. */
  sourceTiers: SourceTier[];
  /** Fraction of evidence items dated within the last 18 months (0–1), or null when undatable. */
  recencyRatio: number | null;
  /** Supporting evidence items (not origins). */
  supportingEvidenceCount: number;
  /** Contradicting evidence items. */
  contradictingEvidenceCount: number;
  /** Claim ambiguity flagged during evidence extraction (0 = precise, 1 = very ambiguous). */
  claimAmbiguity: number;
}

export interface ConfidenceComponents {
  primary_source: number;
  independent_sources: number;
  source_quality: number;
  recency: number;
  agreement: number;
  contradiction_penalty: number;
  ambiguity_penalty: number;
}

export interface ConfidenceResult {
  score: number;
  components: ConfidenceComponents;
}

const WEIGHTS = {
  primary_source: 0.2,
  independent_sources: 0.25,
  source_quality: 0.2,
  recency: 0.1,
  agreement: 0.25,
} as const;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const primary = input.primarySourceFound ? 1 : 0;
  // 3+ independent supporting origins saturate the signal.
  const independent = clamp01(input.independentSupportingSources / 3);
  const quality =
    input.sourceTiers.length === 0
      ? 0
      : input.sourceTiers.reduce((acc, t) => acc + tierScore(t), 0) /
        input.sourceTiers.length;
  const recency = input.recencyRatio === null ? 0.5 : clamp01(input.recencyRatio);
  const totalStance =
    input.supportingEvidenceCount + input.contradictingEvidenceCount;
  const agreement =
    totalStance === 0 ? 0 : input.supportingEvidenceCount / totalStance;

  const base =
    WEIGHTS.primary_source * primary +
    WEIGHTS.independent_sources * independent +
    WEIGHTS.source_quality * quality +
    WEIGHTS.recency * recency +
    WEIGHTS.agreement * agreement;

  // Contradictions and ambiguity subtract — they can never add confidence.
  const contradictionPenalty = clamp01(
    input.independentContradictingSources * 0.15,
  );
  const ambiguityPenalty = clamp01(input.claimAmbiguity) * 0.15;

  const score = clamp01(base - contradictionPenalty - ambiguityPenalty);
  return {
    score: Math.round(score * 100) / 100,
    components: {
      primary_source: primary,
      independent_sources: Math.round(independent * 100) / 100,
      source_quality: Math.round(quality * 100) / 100,
      recency: Math.round(recency * 100) / 100,
      agreement: Math.round(agreement * 100) / 100,
      contradiction_penalty: Math.round(contradictionPenalty * 100) / 100,
      ambiguity_penalty: Math.round(ambiguityPenalty * 100) / 100,
    },
  };
}
