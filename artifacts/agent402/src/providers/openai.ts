/**
 * OpenAI provider implementation using the current OpenAI Responses API
 * (via the Replit AI Integrations proxy). API key lives server-side only
 * (environment variables) and is never exposed to clients.
 *
 * Every call reports token usage and an estimated USD cost so callers can
 * record it in the per-transaction cost ledger.
 */

import {
  ChargedCallError,
  ProviderError,
  type AIProvider,
  type Citation,
  type ExtractOutput,
  type GenerateOutput,
  type ProviderUsage,
  type VerifyOutput,
  type WebSearchOutput,
} from "./index";

/** USD per 1M tokens. Keep transparent + updatable in one place. */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5-mini": { input: 0.25, output: 2.0 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5": { input: 1.25, output: 10.0 },
};
/** Fallback pricing for unknown models — deliberately pessimistic. */
const DEFAULT_PRICE = { input: 2.5, output: 10.0 };

/** USD per web_search tool invocation. */
export const WEB_SEARCH_CALL_COST = 0.01;

const DEFAULT_MODEL = "gpt-5-mini";

/**
 * Hard provider-side limits, matched by estimateCallCost's worst-case math.
 * These make the pre-call budget authorization enforceable: the provider
 * cannot return more output tokens or make more tool calls than authorized.
 */
export const MAX_OUTPUT_TOKENS = {
  generate: 2_000,
  extract: 4_000,
  verify: 4_000,
  webSearch: 4_000,
} as const;
export const MAX_WEB_SEARCH_TOOL_CALLS = 4;

export function tokenCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = MODEL_PRICES[model] ?? DEFAULT_PRICE;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

interface ResponsesJson {
  status?: string;
  output?: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
      annotations?: Array<{ type: string; url?: string; title?: string }>;
    }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  error?: { message?: string } | null;
}

function extractText(json: ResponsesJson): string {
  let text = "";
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && c.text) text += c.text;
    }
  }
  return text;
}

function extractCitations(json: ResponsesJson): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) {
        if (a.type === "url_citation" && a.url && !seen.has(a.url)) {
          seen.add(a.url);
          citations.push({ url: a.url, title: a.title ?? a.url });
        }
      }
    }
  }
  return citations;
}

/** Parse JSON from model output, tolerating markdown code fences. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Last resort: find the first {...} or [...] block.
    const start = candidate.search(/[[{]/);
    if (start >= 0) {
      for (let end = candidate.length; end > start; end -= 1) {
        try {
          return JSON.parse(candidate.slice(start, end));
        } catch {
          /* keep shrinking */
        }
      }
    }
    throw new ProviderError("Model returned unparseable JSON");
  }
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private readonly model: string;

  constructor(model?: string) {
    this.model = model ?? process.env["AGENT402_AI_MODEL"] ?? DEFAULT_MODEL;
  }

  private endpointAndKey(): { url: string; key: string } {
    const base = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
    const key = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
    if (!base || !key) {
      throw new ProviderError(
        "AI provider is not configured (missing AI integration environment variables)",
      );
    }
    return { url: `${base.replace(/\/$/, "")}/responses`, key };
  }

  private async responses(body: Record<string, unknown>): Promise<ResponsesJson> {
    const { url, key } = this.endpointAndKey();
    let res: globalThis.Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, ...body }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new ProviderError(
        `AI provider request failed: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
    if (!res.ok) {
      // Never propagate provider response bodies verbatim (may echo input).
      throw new ProviderError(`AI provider returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as ResponsesJson;
    if (json.error) {
      throw new ProviderError("AI provider returned an error response");
    }
    return json;
  }

  private usageFrom(json: ResponsesJson, webSearchCalls = 0): ProviderUsage {
    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;
    const model = json.model ?? this.model;
    return {
      inputTokens,
      outputTokens,
      model,
      estimatedCostUsd:
        tokenCostUsd(this.model, inputTokens, outputTokens) +
        webSearchCalls * WEB_SEARCH_CALL_COST,
    };
  }

  /**
   * Conservative pre-call cost estimate used for budget authorization
   * BEFORE the call executes. Assumes worst-case output length.
   */
  estimateCallCost(
    kind: "generate" | "extract" | "verify" | "webSearch",
    inputChars: number,
  ): number {
    const inputTokens = Math.ceil(inputChars / 3.5) + 500; // prompt overhead
    if (kind === "webSearch") {
      // Search responses ingest large tool results; tool calls are capped
      // provider-side at MAX_WEB_SEARCH_TOOL_CALLS.
      return (
        tokenCostUsd(this.model, inputTokens + 30_000, MAX_OUTPUT_TOKENS.webSearch) +
        MAX_WEB_SEARCH_TOOL_CALLS * WEB_SEARCH_CALL_COST
      );
    }
    const maxOutput = MAX_OUTPUT_TOKENS[kind];
    return tokenCostUsd(this.model, inputTokens, maxOutput) * 1.5;
  }

  async generate(prompt: string): Promise<GenerateOutput> {
    const json = await this.responses({
      input: prompt,
      max_output_tokens: MAX_OUTPUT_TOKENS.generate,
    });
    return { text: extractText(json), usage: this.usageFrom(json) };
  }

  async extract(content: string, instructions: string): Promise<ExtractOutput> {
    const json = await this.responses({
      instructions: `${instructions}\n\nRespond with STRICT JSON only — no prose, no markdown fences.`,
      input: content,
      max_output_tokens: MAX_OUTPUT_TOKENS.extract,
    });
    const text = extractText(json);
    const usage = this.usageFrom(json);
    try {
      return { data: parseJsonLoose(text), usage };
    } catch (err) {
      // The call was charged even though the output is unusable — surface
      // the cost so the paid-call gateway records it.
      throw new ChargedCallError(
        "Model returned unparseable JSON",
        usage.estimatedCostUsd,
        {
          provider: this.name,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        { cause: err },
      );
    }
  }

  async verify(claim: string, evidence: string[]): Promise<VerifyOutput> {
    const json = await this.responses({
      instructions:
        "Assess whether the evidence supports the claim. Respond with strict JSON: " +
        '{"verdict":"VERIFIED"|"NOT_VERIFIED"|"INSUFFICIENT_EVIDENCE"|"CONFLICTING_EVIDENCE"}',
      input: `CLAIM: ${claim}\n\nEVIDENCE:\n${evidence.map((e, i) => `[${i + 1}] ${e}`).join("\n")}`,
      max_output_tokens: MAX_OUTPUT_TOKENS.verify,
    });
    const usage = this.usageFrom(json);
    let data: { verdict?: string };
    try {
      data = parseJsonLoose(extractText(json)) as { verdict?: string };
    } catch (err) {
      throw new ChargedCallError(
        "Model returned unparseable JSON",
        usage.estimatedCostUsd,
        {
          provider: this.name,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        { cause: err },
      );
    }
    return {
      verdict: typeof data.verdict === "string" ? data.verdict : "INSUFFICIENT_EVIDENCE",
      usage,
    };
  }

  async webSearch(query: string, instructions?: string): Promise<WebSearchOutput> {
    const json = await this.responses({
      input: query,
      instructions:
        instructions ??
        "Search the web and answer using ONLY information from the search results, with citations for every claim. Prefer primary and authoritative sources.",
      tools: [{ type: "web_search" }],
      max_output_tokens: MAX_OUTPUT_TOKENS.webSearch,
      max_tool_calls: MAX_WEB_SEARCH_TOOL_CALLS,
    });
    const webSearchCalls = (json.output ?? []).filter(
      (o) => o.type === "web_search_call",
    ).length;
    return {
      text: extractText(json),
      citations: extractCitations(json),
      webSearchCalls,
      usage: this.usageFrom(json, webSearchCalls),
    };
  }
}
