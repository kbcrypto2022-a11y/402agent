/**
 * VERIFY — evidence-based claim verification (the premium product).
 *
 * Pipeline: SEARCH → SELECT BEST SOURCES → READ ACTUAL SOURCES → EXTRACT
 * RELEVANT EVIDENCE → LOOK FOR CONTRADICTORY EVIDENCE → COMPARE SOURCES →
 * VERDICT. Verdicts are one of VERIFIED / NOT_VERIFIED /
 * INSUFFICIENT_EVIDENCE / CONFLICTING_EVIDENCE — never a forced binary.
 *
 * The final verdict comes from a DETERMINISTIC, conservative aggregation of
 * extracted evidence (independent origins, tiers, contradictions) — not
 * from the model's subjective feeling.
 */

import { z } from "zod";
import type { SourceTier, Verdict } from "../accuracy";
import { computeConfidence, type ConfidenceResult } from "../accuracy/confidence";
import { dedupeByOrigin, independentOriginCount } from "../accuracy/corroboration";
import { rankSources, type RankedSource } from "../accuracy/tiering";
import { ChargedCallError, type AIProvider } from "../providers";
import { ApiError } from "../security/errors";
import { BudgetExceededError } from "../pricing/budget";
import { fetchReadableContent } from "./read";
import { runSearch } from "./search";
import { paidCall, withRetries, type SpendContext } from "./spend";

const MAX_SOURCES_TO_READ = 2;
const SOURCE_EXCERPT_CHARS = 7_000;
const RECENT_MONTHS = 18;

const evidenceSchema = z.object({
  evidence: z
    .array(
      z.object({
        source_url: z.string(),
        stance: z.enum(["supports", "contradicts", "neutral"]),
        statement: z.string(),
        quote: z.string().nullable().default(null),
        /** Upstream origin when this source merely repeats another (syndication). */
        derived_from: z.string().nullable().default(null),
        published_date: z.string().nullable().default(null),
      }),
    )
    .default([]),
  claim_ambiguity: z.number().min(0).max(1).default(0),
});

export interface EvidenceItem {
  source_url: string;
  stance: "supports" | "contradicts" | "neutral";
  statement: string;
  quote: string | null;
  derived_from: string | null;
  published_date: string | null;
  tier: SourceTier;
}

export interface VerifyResponse {
  service: "verify";
  claim: string;
  verdict: Verdict;
  confidence: number;
  confidence_components: ConfidenceResult["components"];
  summary: string;
  supporting_evidence: EvidenceItem[];
  contradictory_evidence: EvidenceItem[];
  sources: RankedSource[];
  source_count: number;
  primary_source_found: boolean;
  generated_at: string;
  budget_limited?: boolean;
}

function isRecent(dateStr: string | null): boolean | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  const cutoff = Date.now() - RECENT_MONTHS * 30.44 * 24 * 3600 * 1000;
  return t >= cutoff;
}

/**
 * Deterministic, conservative verdict rules.
 * Exported for direct testing and benchmark evaluation.
 */
export function decideVerdict(input: {
  independentSupporting: number;
  independentContradicting: number;
  primarySourceFound: boolean;
  confidence: number;
}): Verdict {
  const { independentSupporting: s, independentContradicting: c } = input;
  if (s > 0 && c > 0) return "CONFLICTING_EVIDENCE";
  if (c > 0) return "NOT_VERIFIED";
  if (s === 0) return "INSUFFICIENT_EVIDENCE";
  // Supporting evidence only: be conservative about declaring VERIFIED.
  const strongEnough = input.primarySourceFound || s >= 2;
  if (strongEnough && input.confidence >= 0.55) return "VERIFIED";
  return "INSUFFICIENT_EVIDENCE";
}

export async function runVerify(
  claim: string,
  provider: AIProvider,
  ctx: SpendContext,
): Promise<VerifyResponse> {
  // 1) SEARCH for evidence about the claim (both directions).
  const search = await runSearch(
    `Evidence for or against this claim: ${claim}`,
    provider,
    ctx,
  );

  const now = () => new Date().toISOString();
  const emptyConfidence = computeConfidence({
    primarySourceFound: false,
    independentSupportingSources: 0,
    independentContradictingSources: 0,
    sourceTiers: [],
    recencyRatio: null,
    supportingEvidenceCount: 0,
    contradictingEvidenceCount: 0,
    claimAmbiguity: 0.5,
  });

  if (search.results.length === 0) {
    return {
      service: "verify",
      claim,
      verdict: "INSUFFICIENT_EVIDENCE",
      confidence: emptyConfidence.score,
      confidence_components: emptyConfidence.components,
      summary: "No citable sources were found for this claim.",
      supporting_evidence: [],
      contradictory_evidence: [],
      sources: [],
      source_count: 0,
      primary_source_found: false,
      generated_at: now(),
    };
  }

  // 2) SELECT best sources: tier-ranked, one per independent origin.
  const candidates = dedupeByOrigin(rankSources(search.results));
  const toRead = candidates.slice(0, MAX_SOURCES_TO_READ);
  const tierByUrl = new Map(candidates.map((s) => [s.url, s.tier]));

  // 3) READ actual sources (budget permitting — stop gracefully, never
  //    silently exceed the hard budget).
  let budgetLimited = false;
  const excerpts: Array<{ url: string; tier: SourceTier; text: string }> = [];
  for (const src of toRead) {
    try {
      const content = await fetchReadableContent(src.url, ctx);
      if (content.text.trim().length >= 40) {
        excerpts.push({
          url: src.url,
          tier: src.tier,
          text: content.text.slice(0, SOURCE_EXCERPT_CHARS),
        });
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetLimited = true;
        break;
      }
      // Unreachable/rejected source: skip it, keep the pipeline going.
      if (err instanceof ApiError) continue;
      throw err;
    }
  }

  // Fall back to search snippets when nothing could be read.
  const evidenceCorpus =
    excerpts.length > 0
      ? excerpts
          .map((e) => `SOURCE (tier ${e.tier}): ${e.url}\n${e.text}`)
          .join("\n\n=====\n\n")
      : candidates
          .slice(0, 6)
          .map((s) => `SOURCE (tier ${s.tier}): ${s.url}\nTitle: ${s.title}\nSnippet: ${s.snippet ?? ""}`)
          .join("\n\n");

  // 4–6) EXTRACT evidence, ACTIVELY seek contradictions, COMPARE sources.
  const input = `CLAIM TO VERIFY: ${claim}\n\nSOURCE MATERIAL:\n${evidenceCorpus}`;
  const instructions =
    `You are verifying the claim against the source material ONLY. Produce JSON ` +
    `{"evidence":[{"source_url","stance","statement","quote","derived_from","published_date"}],"claim_ambiguity":0..1}. ` +
    `stance: "supports" only if the source directly supports the claim; "contradicts" if it directly contradicts it; else "neutral". ` +
    `ACTIVELY look for contradictory evidence — do not only look for confirmation. ` +
    `quote = the exact passage relied on (or null). derived_from = the upstream origin domain when the source merely repeats ` +
    `another outlet's reporting (e.g. "reuters.com"), else null. published_date = ISO date if determinable, else null. ` +
    `claim_ambiguity: 0 = precise falsifiable claim, 1 = hopelessly vague. Use ONLY source_url values that appear in the material.`;

  let extraction: z.infer<typeof evidenceSchema>;
  try {
    extraction = await withRetries(ctx.config.maxRetries, async (attempt) =>
      paidCall(
        ctx,
        "ai",
        provider.estimateCallCost("verify", input.length),
        attempt === 0 ? "evidence extraction & comparison" : "evidence extraction (retry)",
        async () => {
          const out = await provider.extract(input, instructions);
          const meta = {
            provider: provider.name,
            model: out.usage.model,
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            ...(attempt > 0 ? { retry: true } : {}),
          };
          const parsed = evidenceSchema.safeParse(out.data);
          if (!parsed.success) {
            // Charged, but output unusable — cost still must be recorded.
            throw new ChargedCallError(
              "Evidence output failed validation",
              out.usage.estimatedCostUsd,
              meta,
              { cause: parsed.error },
            );
          }
          return {
            value: parsed.data,
            actualCost: out.usage.estimatedCostUsd,
            meta,
          };
        },
      ),
    );
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    throw new ApiError(
      502,
      "PROVIDER_ERROR",
      "Evidence analysis failed; the claim was not assessed.",
    );
  }

  const knownUrls = new Set([
    ...candidates.map((s) => s.url),
    ...excerpts.map((e) => e.url),
  ]);
  const evidence: EvidenceItem[] = extraction.evidence
    .filter((e) => knownUrls.has(e.source_url))
    .map((e) => ({
      ...e,
      tier: tierByUrl.get(e.source_url) ?? "E",
    }));

  const supporting = evidence.filter((e) => e.stance === "supports");
  const contradicting = evidence.filter((e) => e.stance === "contradicts");

  // Independent corroboration: same-origin (and same-upstream) dedup.
  const independentSupporting = independentOriginCount(
    supporting.map((e) => ({ url: e.source_url, derived_from: e.derived_from })),
  );
  const independentContradicting = independentOriginCount(
    contradicting.map((e) => ({ url: e.source_url, derived_from: e.derived_from })),
  );

  const usedTiers = evidence
    .filter((e) => e.stance !== "neutral")
    .map((e) => e.tier);
  const primarySourceFound = supporting.some((e) => e.tier === "A");

  const dated = evidence
    .filter((e) => e.stance !== "neutral")
    .map((e) => isRecent(e.published_date))
    .filter((r): r is boolean => r !== null);
  const recencyRatio =
    dated.length === 0 ? null : dated.filter(Boolean).length / dated.length;

  // 7) Transparent confidence from measurable signals; components stored.
  const confidence = computeConfidence({
    primarySourceFound,
    independentSupportingSources: supporting.length === 0 ? 0 : independentSupporting,
    independentContradictingSources:
      contradicting.length === 0 ? 0 : independentContradicting,
    sourceTiers: usedTiers,
    recencyRatio,
    supportingEvidenceCount: supporting.length,
    contradictingEvidenceCount: contradicting.length,
    claimAmbiguity: extraction.claim_ambiguity,
  });

  // 8) Deterministic verdict.
  const verdict = decideVerdict({
    independentSupporting: supporting.length === 0 ? 0 : independentSupporting,
    independentContradicting: contradicting.length === 0 ? 0 : independentContradicting,
    primarySourceFound,
    confidence: confidence.score,
  });

  const sourcesUsed = rankSources(
    candidates.filter((s) =>
      evidence.some((e) => e.source_url === s.url && e.stance !== "neutral"),
    ),
  );

  const summaryParts: string[] = [];
  if (supporting.length > 0)
    summaryParts.push(
      `${supporting.length} supporting evidence item(s) across ${independentSupporting} independent origin(s)${primarySourceFound ? ", including a primary (tier A) source" : ""}.`,
    );
  if (contradicting.length > 0)
    summaryParts.push(
      `${contradicting.length} contradictory evidence item(s) across ${independentContradicting} independent origin(s).`,
    );
  if (supporting.length === 0 && contradicting.length === 0)
    summaryParts.push("No direct supporting or contradictory evidence was found in the examined sources.");
  if (budgetLimited)
    summaryParts.push("Analysis was limited by the fulfillment cost budget.");

  return {
    service: "verify",
    claim,
    verdict,
    confidence: confidence.score,
    confidence_components: confidence.components,
    summary: summaryParts.join(" "),
    supporting_evidence: supporting,
    contradictory_evidence: contradicting,
    sources: sourcesUsed,
    source_count: sourcesUsed.length,
    primary_source_found: primarySourceFound,
    generated_at: now(),
    ...(budgetLimited ? { budget_limited: true } : {}),
  };
}
