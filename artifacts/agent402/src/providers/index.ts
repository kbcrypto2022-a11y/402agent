/**
 * AI / external provider abstraction. Services never couple directly to a
 * single vendor SDK — they depend on these interfaces only.
 */

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Estimated USD cost of this single call (tokens + tool surcharges). */
  estimatedCostUsd: number;
}

export interface Citation {
  url: string;
  title: string;
}

export interface WebSearchOutput {
  /** The provider's synthesized, citation-backed answer text. */
  text: string;
  /** URL citations actually returned by the search tool. */
  citations: Citation[];
  /** Number of web-search tool invocations billed. */
  webSearchCalls: number;
  usage: ProviderUsage;
}

export interface GenerateOutput {
  text: string;
  usage: ProviderUsage;
}

export interface ExtractOutput {
  data: unknown;
  usage: ProviderUsage;
}

export interface VerifyOutput {
  verdict: string;
  usage: ProviderUsage;
}

export interface AIProvider {
  readonly name: string;
  /** Free-form text generation. */
  generate(prompt: string): Promise<GenerateOutput>;
  /** Structured (JSON) extraction from provided content. */
  extract(content: string, instructions: string): Promise<ExtractOutput>;
  /** Lightweight claim-vs-evidence assessment (interface completeness). */
  verify(claim: string, evidence: string[]): Promise<VerifyOutput>;
  /** Web search grounded in real citations. */
  webSearch(query: string, instructions?: string): Promise<WebSearchOutput>;
  /** Conservative pre-call cost estimate for budget authorization. */
  estimateCallCost(kind: "generate" | "extract" | "verify" | "webSearch", inputChars: number): number;
}

/**
 * Thrown when a provider call was CHARGED (usage came back) but its output
 * could not be used (e.g. unparseable/invalid JSON). Carries the actual
 * cost so the paid-call gateway records it in the ledger and reconciles the
 * budget even though the call failed.
 */
export class ChargedCallError extends Error {
  constructor(
    message: string,
    public readonly actualCost: number,
    public readonly meta?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ChargedCallError";
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string = "PROVIDER_ERROR",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
