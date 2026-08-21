/**
 * Accuracy framework: source-quality tiers, independent corroboration, and
 * the transparent confidence calculation.
 */

export const SOURCE_TIERS = ["A", "B", "C", "D", "E"] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const VERDICTS = [
  "VERIFIED",
  "NOT_VERIFIED",
  "INSUFFICIENT_EVIDENCE",
  "CONFLICTING_EVIDENCE",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export { classifySourceTier, tierScore, rankSources, type RankedSource } from "./tiering";
export {
  canonicalOrigin,
  dedupeByOrigin,
  independentOriginCount,
} from "./corroboration";
export {
  computeConfidence,
  type ConfidenceComponents,
  type ConfidenceInput,
  type ConfidenceResult,
} from "./confidence";
