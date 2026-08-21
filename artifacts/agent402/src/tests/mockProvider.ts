/** Deterministic AIProvider mock — automated tests never spend real money. */

import type {
  AIProvider,
  ExtractOutput,
  GenerateOutput,
  ProviderUsage,
  VerifyOutput,
  WebSearchOutput,
  Citation,
} from "../providers";

const usage = (cost = 0.001): ProviderUsage => ({
  inputTokens: 100,
  outputTokens: 50,
  model: "mock-model",
  estimatedCostUsd: cost,
});

export interface MockScript {
  citations?: Citation[];
  searchText?: string;
  /** Queue of extract() payloads, returned in order (last repeats). */
  extractQueue?: unknown[];
}

export class MockProvider implements AIProvider {
  readonly name = "mock";
  calls: string[] = [];
  private extractIdx = 0;

  constructor(private script: MockScript = {}) {}

  estimateCallCost(): number {
    return 0.002;
  }

  async generate(prompt: string): Promise<GenerateOutput> {
    this.calls.push(`generate:${prompt.slice(0, 30)}`);
    return { text: "mock generation", usage: usage() };
  }

  async extract(): Promise<ExtractOutput> {
    this.calls.push("extract");
    const q = this.script.extractQueue ?? [];
    const data = q.length === 0 ? {} : q[Math.min(this.extractIdx, q.length - 1)];
    this.extractIdx += 1;
    return { data, usage: usage() };
  }

  async verify(): Promise<VerifyOutput> {
    this.calls.push("verify");
    return { verdict: "INSUFFICIENT_EVIDENCE", usage: usage() };
  }

  async webSearch(query: string): Promise<WebSearchOutput> {
    this.calls.push(`webSearch:${query.slice(0, 40)}`);
    return {
      text: this.script.searchText ?? "mock search answer",
      citations: this.script.citations ?? [],
      webSearchCalls: 1,
      usage: usage(0.012),
    };
  }
}
