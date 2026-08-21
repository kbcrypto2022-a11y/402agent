/**
 * Source-quality tiering (A–E).
 *
 * Tier is NOT domain reputation alone: deterministic domain heuristics give
 * a baseline, and the model's per-result assessment (originality,
 * independence, recency, author identifiability) can only DOWNGRADE a
 * result from the heuristic baseline — never upgrade it. That keeps tier
 * assignment conservative and prevents confident-sounding AI upgrades.
 */

import type { SourceTier } from "./index";

const TIER_ORDER: Record<SourceTier, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };

/** Numeric quality score for confidence math (A best). */
export function tierScore(tier: SourceTier): number {
  switch (tier) {
    case "A":
      return 1.0;
    case "B":
      return 0.8;
    case "C":
      return 0.6;
    case "D":
      return 0.35;
    case "E":
      return 0.1;
  }
}

const TIER_B_HOSTS = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "nytimes.com",
  "washingtonpost.com",
  "economist.com",
  "bbc.com",
  "bbc.co.uk",
  "afp.com",
  "nature.com",
  "science.org",
  "nejm.org",
  "thelancet.com",
];

const TIER_C_HOSTS = [
  "techcrunch.com",
  "theverge.com",
  "arstechnica.com",
  "wired.com",
  "cnbc.com",
  "forbes.com",
  "axios.com",
  "theguardian.com",
  "politico.com",
  "spacenews.com",
  "statnews.com",
  "theinformation.com",
  "semianalysis.com",
  "tomshardware.com",
  "anandtech.com",
];

const TIER_E_HOSTS = [
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "4chan.org",
  "t.me",
  "telegram.me",
  "pinterest.com",
];

const TIER_D_HOSTS = [
  "medium.com",
  "substack.com",
  "blogspot.com",
  "wordpress.com",
  "tumblr.com",
  "quora.com",
  "fandom.com",
  "wikipedia.org", // useful but an aggregator, not citable authority
  "linkedin.com",
  "news.ycombinator.com",
  "seekingalpha.com",
];

/**
 * Companies whose official IR/newsroom/press subdomains count as primary
 * (tier A) sources. Verified ownership only — an unknown domain with a
 * `news.` or `ir.` subdomain stays non-primary.
 */
const CORPORATE_PRIMARY_DOMAINS = [
  "nvidia.com",
  "apple.com",
  "microsoft.com",
  "alphabet.com",
  "google.com",
  "abc.xyz",
  "amazon.com",
  "aboutamazon.com",
  "meta.com",
  "fb.com",
  "tesla.com",
  "netflix.com",
  "intel.com",
  "amd.com",
  "ibm.com",
  "oracle.com",
  "salesforce.com",
  "adobe.com",
  "cisco.com",
  "qualcomm.com",
  "broadcom.com",
  "tsmc.com",
  "samsung.com",
  "sony.com",
  "openai.com",
  "anthropic.com",
  "spacex.com",
  "boeing.com",
  "airbus.com",
  "jpmorganchase.com",
  "goldmansachs.com",
  "berkshirehathaway.com",
  "walmart.com",
  "exxonmobil.com",
  "chevron.com",
  "pfizer.com",
  "moderna.com",
  "jnj.com",
  "unitedhealthgroup.com",
  "ge.com",
  "ford.com",
  "gm.com",
  "toyota.com",
  "volkswagen.com",
  "shell.com",
  "bp.com",
  "disney.com",
  "thewaltdisneycompany.com",
];

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Deterministic baseline tier from the URL alone.
 * A = primary/authoritative (government, regulators, courts, SEC filings,
 *     official corporate newsrooms/IR pages, original research hosts).
 */
export function classifySourceTier(rawUrl: string): SourceTier {
  const host = hostOf(rawUrl);
  if (!host) return "E";

  // Tier A — governments, regulators, courts, standards bodies, filings.
  if (
    /\.(gov|mil)(\.[a-z]{2})?$/.test(host) ||
    host.endsWith(".gov.uk") ||
    host.endsWith(".europa.eu") ||
    host.endsWith(".int") ||
    host === "sec.gov" ||
    host.endsWith(".uscourts.gov") ||
    host === "federalreserve.gov" ||
    host === "who.int" ||
    host === "un.org" ||
    host.endsWith(".un.org")
  ) {
    return "A";
  }
  // Tier A — official corporate primary channels (IR/newsroom/press
  // subdomains), ONLY for allowlisted companies. A generic `news.*` or
  // `ir.*` subdomain on an unknown domain must never be promoted to
  // primary: anyone can register `ir.attacker-corp.com`.
  const sub = host.split(".")[0] ?? "";
  if (
    ["investor", "investors", "ir", "newsroom", "press", "news"].includes(sub) &&
    hostMatches(host, CORPORATE_PRIMARY_DOMAINS)
  ) {
    return "A";
  }
  // Tier A/B — academic and research.
  if (/\.edu(\.[a-z]{2})?$/.test(host) || host.endsWith(".ac.uk")) return "B";
  if (host === "arxiv.org" || host === "pubmed.ncbi.nlm.nih.gov" || host === "doi.org")
    return "B";

  if (hostMatches(host, TIER_E_HOSTS)) return "E";
  if (hostMatches(host, TIER_B_HOSTS)) return "B";
  if (hostMatches(host, TIER_C_HOSTS)) return "C";
  if (hostMatches(host, TIER_D_HOSTS)) return "D";

  // Unknown hosts default to D (lower-authority) — conservative.
  return "D";
}

/** Combine the heuristic baseline with a model-suggested tier: model can only downgrade. */
export function mergeTier(
  heuristic: SourceTier,
  suggested: string | undefined,
): SourceTier {
  const s = (suggested ?? "").toUpperCase() as SourceTier;
  if (!(s in TIER_ORDER)) return heuristic;
  return TIER_ORDER[s] > TIER_ORDER[heuristic] ? s : heuristic;
}

export interface RankedSource {
  url: string;
  title: string;
  tier: SourceTier;
  tier_reason: string;
  snippet?: string;
  published_date?: string | null;
}

/** Sort best-tier first; stable within a tier. */
export function rankSources<T extends { tier: SourceTier }>(sources: T[]): T[] {
  return [...sources].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}
