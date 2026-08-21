/**
 * SEARCH — find current, relevant, high-quality information.
 *
 * Results are grounded in real web citations from the search tool: a result
 * without a citation URL is discarded, so SEARCH never returns unsourced
 * AI-generated claims. Sources are tier-ranked (A–E) considering
 * originality, independence, recency, and identifiability.
 */

import { z } from "zod";
import { mergeTier, classifySourceTier, rankSources, type RankedSource } from "../accuracy/tiering";
import { ChargedCallError, type AIProvider } from "../providers";
import { paidCall, withRetries, type SpendContext } from "./spend";

const structuredResultsSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().default(""),
        snippet: z.string().default(""),
        published_date: z.string().nullable().default(null),
        suggested_tier: z.string().optional(),
        tier_reason: z.string().default(""),
      }),
    )
    .default([]),
});

export interface SearchResponse {
  service: "search";
  query: string;
  results: RankedSource[];
  sources: string[];
  generated_at: string;
}

export async function runSearch(
  query: string,
  provider: AIProvider,
  ctx: SpendContext,
): Promise<SearchResponse> {
  // 1) Web search (paid; authorized before executing).
  const search = await paidCall(
    ctx,
    "search",
    provider.estimateCallCost("webSearch", query.length),
    "web search (grounded, cited)",
    async () => {
      const out = await provider.webSearch(query);
      return {
        value: out,
        actualCost: out.usage.estimatedCostUsd,
        meta: {
          provider: provider.name,
          model: out.usage.model,
          inputTokens: out.usage.inputTokens,
          outputTokens: out.usage.outputTokens,
        },
      };
    },
  );

  if (search.citations.length === 0) {
    // No evidence — return empty results rather than unsourced claims.
    return {
      service: "search",
      query,
      results: [],
      sources: [],
      generated_at: new Date().toISOString(),
    };
  }

  // 2) Structure results (cheap AI call, also budget-authorized).
  const structureInput =
    `QUERY: ${query}\n\nSEARCH ANSWER (citation-backed):\n${search.text.slice(0, 8000)}\n\n` +
    `CITED SOURCES:\n${search.citations.map((c, i) => `[${i + 1}] ${c.title} — ${c.url}`).join("\n")}`;
  const instructions =
    `From the cited sources above, produce JSON {"results":[{"url","title","snippet","published_date","suggested_tier","tier_reason"}]}. ` +
    `Only include URLs that appear in CITED SOURCES — never invent URLs. snippet = what this source says relevant to the query. ` +
    `published_date = ISO date if stated, else null. suggested_tier = A(primary/official/gov) B(top independent journalism/academic) ` +
    `C(established specialized publication) D(blog/aggregator) E(social/anonymous), judged by originality, independence, recency, and ` +
    `whether the author/organization is identifiable. tier_reason = one short sentence.`;

  const structured = await withRetries(ctx.config.maxRetries, async (attempt) =>
    paidCall(
      ctx,
      "ai",
      provider.estimateCallCost("extract", structureInput.length),
      attempt === 0 ? "search result structuring" : "search result structuring (retry)",
      async () => {
        const out = await provider.extract(structureInput, instructions);
        const meta = {
          provider: provider.name,
          model: out.usage.model,
          inputTokens: out.usage.inputTokens,
          outputTokens: out.usage.outputTokens,
          ...(attempt > 0 ? { retry: true } : {}),
        };
        const parsedResult = structuredResultsSchema.safeParse(out.data);
        if (!parsedResult.success) {
          // Charged, but output unusable — cost still must be recorded.
          throw new ChargedCallError(
            "Structuring output failed validation",
            out.usage.estimatedCostUsd,
            meta,
            { cause: parsedResult.error },
          );
        }
        return {
          value: parsedResult.data,
          actualCost: out.usage.estimatedCostUsd,
          meta,
        };
      },
    ),
  );

  const citedUrls = new Set(search.citations.map((c) => c.url));
  const results: RankedSource[] = structured.results
    .filter((r) => citedUrls.has(r.url)) // hard grounding: cited URLs only
    .map((r) => {
      const heuristic = classifySourceTier(r.url);
      const tier = mergeTier(heuristic, r.suggested_tier);
      return {
        url: r.url,
        title: r.title || search.citations.find((c) => c.url === r.url)?.title || r.url,
        snippet: r.snippet,
        published_date: r.published_date,
        tier,
        tier_reason: r.tier_reason || `Domain heuristic: tier ${heuristic}`,
      };
    });

  // Include any cited URLs the structuring step dropped (grounding > polish).
  for (const c of search.citations) {
    if (!results.some((r) => r.url === c.url)) {
      const tier = classifySourceTier(c.url);
      results.push({
        url: c.url,
        title: c.title,
        snippet: "",
        published_date: null,
        tier,
        tier_reason: `Domain heuristic: tier ${tier}`,
      });
    }
  }

  const ranked = rankSources(results);
  return {
    service: "search",
    query,
    results: ranked,
    sources: ranked.map((r) => r.url),
    generated_at: new Date().toISOString(),
  };
}
