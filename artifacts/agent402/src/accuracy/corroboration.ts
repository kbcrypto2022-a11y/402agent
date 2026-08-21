/**
 * Independent-corroboration logic.
 *
 * Five websites repeating the same wire story are NOT five independent
 * confirmations. We approximate independence by registrable origin
 * (canonical domain), plus explicit `derived_from` hints when the evidence
 * extraction step identifies syndication ("according to Reuters", etc.).
 */

const TWO_LEVEL_TLDS = new Set([
  "co.uk",
  "ac.uk",
  "gov.uk",
  "org.uk",
  "com.au",
  "gov.au",
  "co.jp",
  "co.kr",
  "com.br",
  "co.in",
  "com.cn",
  "com.mx",
]);

/** Canonical registrable origin of a URL, e.g. "investor.nvidia.com" → "nvidia.com". */
export function canonicalOrigin(rawUrl: string): string {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return rawUrl.toLowerCase();
  }
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join(".");
  return lastTwo;
}

/** Keep the first (best-ranked) source per origin. */
export function dedupeByOrigin<T extends { url: string }>(sources: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of sources) {
    const origin = canonicalOrigin(s.url);
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(s);
  }
  return out;
}

/**
 * Count independent origins among items, collapsing entries whose
 * `derived_from` names the same upstream origin (syndicated copies).
 */
export function independentOriginCount(
  items: Array<{ url: string; derived_from?: string | null }>,
): number {
  const origins = new Set<string>();
  for (const item of items) {
    const upstream = item.derived_from?.trim();
    origins.add(
      upstream && upstream.length > 0
        ? canonicalOrigin(upstream.includes("://") ? upstream : `https://${upstream}`)
        : canonicalOrigin(item.url),
    );
  }
  return origins.size;
}
