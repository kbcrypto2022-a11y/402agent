import { describe, expect, it } from "vitest";
import {
  canonicalOrigin,
  dedupeByOrigin,
  independentOriginCount,
} from "../accuracy/corroboration";
import { computeConfidence } from "../accuracy/confidence";
import { classifySourceTier, mergeTier, rankSources } from "../accuracy/tiering";
import { decideVerdict } from "../services/verify";

describe("source tiering", () => {
  it("classifies primary/authoritative sources as tier A", () => {
    expect(classifySourceTier("https://www.sec.gov/filings/x")).toBe("A");
    expect(classifySourceTier("https://www.fda.gov/news")).toBe("A");
    expect(classifySourceTier("https://investor.nvidia.com/news/x")).toBe("A");
    expect(classifySourceTier("https://newsroom.intel.com/pr")).toBe("A");
  });

  it("never promotes attacker-controlled news./ir. subdomains to primary", () => {
    // Anyone can register these — they must stay non-primary (tier D).
    expect(classifySourceTier("https://news.attacker.example/breaking")).toBe("D");
    expect(classifySourceTier("https://ir.attacker-corp.com/results")).toBe("D");
    expect(classifySourceTier("https://newsroom.example-corp.com/pr")).toBe("D");
    expect(classifySourceTier("https://press.random-startup.io/launch")).toBe("D");
  });
  it("classifies reputable journalism as tier B and social as tier E", () => {
    expect(classifySourceTier("https://www.reuters.com/tech/x")).toBe("B");
    expect(classifySourceTier("https://apnews.com/article/y")).toBe("B");
    expect(classifySourceTier("https://x.com/someone/status/1")).toBe("E");
    expect(classifySourceTier("https://www.reddit.com/r/news/z")).toBe("E");
  });
  it("defaults unknown hosts to tier D (conservative)", () => {
    expect(classifySourceTier("https://random-unknown-site.io/post")).toBe("D");
  });
  it("model suggestions can only downgrade, never upgrade", () => {
    expect(mergeTier("B", "A")).toBe("B"); // no upgrade
    expect(mergeTier("B", "D")).toBe("D"); // downgrade allowed
    expect(mergeTier("C", "garbage")).toBe("C");
  });
  it("ranks best tiers first", () => {
    const ranked = rankSources([
      { tier: "D" as const },
      { tier: "A" as const },
      { tier: "C" as const },
    ]);
    expect(ranked.map((r) => r.tier)).toEqual(["A", "C", "D"]);
  });
});

describe("independent corroboration", () => {
  it("collapses subdomains to a registrable origin", () => {
    expect(canonicalOrigin("https://investor.nvidia.com/x")).toBe("nvidia.com");
    expect(canonicalOrigin("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
  });
  it("dedupes multiple pages from the same origin", () => {
    const out = dedupeByOrigin([
      { url: "https://a.example.com/1" },
      { url: "https://b.example.com/2" },
      { url: "https://other.org/3" },
    ]);
    expect(out).toHaveLength(2);
  });
  it("does not count syndicated copies as independent confirmations", () => {
    const count = independentOriginCount([
      { url: "https://site1.com/a", derived_from: "reuters.com" },
      { url: "https://site2.com/b", derived_from: "reuters.com" },
      { url: "https://www.reuters.com/c", derived_from: null },
    ]);
    expect(count).toBe(1); // five copies of one wire story = one origin
  });
});

describe("confidence calculation", () => {
  it("stays within 0.00–1.00 and stores component scores", () => {
    const strong = computeConfidence({
      primarySourceFound: true,
      independentSupportingSources: 3,
      independentContradictingSources: 0,
      sourceTiers: ["A", "B", "B"],
      recencyRatio: 1,
      supportingEvidenceCount: 4,
      contradictingEvidenceCount: 0,
      claimAmbiguity: 0,
    });
    expect(strong.score).toBeGreaterThan(0.8);
    expect(strong.score).toBeLessThanOrEqual(1);
    expect(strong.components.primary_source).toBe(1);
    expect(strong.components.agreement).toBe(1);

    const weak = computeConfidence({
      primarySourceFound: false,
      independentSupportingSources: 0,
      independentContradictingSources: 3,
      sourceTiers: ["E"],
      recencyRatio: 0,
      supportingEvidenceCount: 0,
      contradictingEvidenceCount: 3,
      claimAmbiguity: 1,
    });
    expect(weak.score).toBeGreaterThanOrEqual(0);
    expect(weak.score).toBeLessThan(0.2);
    expect(weak.components.contradiction_penalty).toBeGreaterThan(0);
  });

  it("contradictions reduce confidence", () => {
    const base = {
      primarySourceFound: true,
      independentSupportingSources: 2,
      independentContradictingSources: 0,
      sourceTiers: ["A", "B"] as ("A" | "B")[],
      recencyRatio: 1,
      supportingEvidenceCount: 2,
      contradictingEvidenceCount: 0,
      claimAmbiguity: 0,
    };
    const clean = computeConfidence(base);
    const contested = computeConfidence({
      ...base,
      independentContradictingSources: 2,
      contradictingEvidenceCount: 2,
    });
    expect(contested.score).toBeLessThan(clean.score);
  });
});

describe("deterministic verdict rules", () => {
  it("returns VERIFIED for strong independent support", () => {
    expect(
      decideVerdict({
        independentSupporting: 2,
        independentContradicting: 0,
        primarySourceFound: false,
        confidence: 0.7,
      }),
    ).toBe("VERIFIED");
    expect(
      decideVerdict({
        independentSupporting: 1,
        independentContradicting: 0,
        primarySourceFound: true,
        confidence: 0.6,
      }),
    ).toBe("VERIFIED");
  });
  it("returns NOT_VERIFIED when only contradictions exist", () => {
    expect(
      decideVerdict({
        independentSupporting: 0,
        independentContradicting: 1,
        primarySourceFound: false,
        confidence: 0.4,
      }),
    ).toBe("NOT_VERIFIED");
  });
  it("returns CONFLICTING_EVIDENCE when both sides have evidence", () => {
    expect(
      decideVerdict({
        independentSupporting: 2,
        independentContradicting: 1,
        primarySourceFound: true,
        confidence: 0.5,
      }),
    ).toBe("CONFLICTING_EVIDENCE");
  });
  it("returns INSUFFICIENT_EVIDENCE with no evidence or weak support", () => {
    expect(
      decideVerdict({
        independentSupporting: 0,
        independentContradicting: 0,
        primarySourceFound: false,
        confidence: 0.1,
      }),
    ).toBe("INSUFFICIENT_EVIDENCE");
    // One non-primary source is never enough — conservative by design.
    expect(
      decideVerdict({
        independentSupporting: 1,
        independentContradicting: 0,
        primarySourceFound: false,
        confidence: 0.9,
      }),
    ).toBe("INSUFFICIENT_EVIDENCE");
    // Low confidence blocks VERIFIED even with support.
    expect(
      decideVerdict({
        independentSupporting: 2,
        independentContradicting: 0,
        primarySourceFound: true,
        confidence: 0.3,
      }),
    ).toBe("INSUFFICIENT_EVIDENCE");
  });
});
