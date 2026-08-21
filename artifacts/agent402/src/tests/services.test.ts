import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { MemoryTransactionStore } from "../database/memoryStore";
import { CostLedger } from "../costs/ledger";
import { BudgetTracker } from "../pricing/budget";
import { createRealFulfiller } from "../services/fulfillment";
import { fetchReadableContent } from "../services/read";
import { runSearch } from "../services/search";
import { runVerify, type VerifyResponse } from "../services/verify";
import { SafeFetchError, type SafeFetchFailureKind } from "../security/ssrf";
import { MockProvider, type MockScript } from "./mockProvider";
import { testConfig } from "./pricing.test";

const BASE = "/agent402/api/v1";

function ctx() {
  return {
    config: testConfig(),
    budget: new BudgetTracker(1),
    ledger: new CostLedger("tx_test"),
  };
}

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

describe("SEARCH service", () => {
  it("returns tier-ranked, citation-grounded results and records costs", async () => {
    const provider = new MockProvider({
      citations: [
        { url: "https://blog.random-site.io/post", title: "Some blog" },
        { url: "https://www.sec.gov/filing/123", title: "SEC filing" },
        { url: "https://www.reuters.com/article/x", title: "Reuters" },
      ],
      extractQueue: [
        {
          results: [
            {
              url: "https://www.sec.gov/filing/123",
              title: "SEC filing",
              snippet: "Official filing",
              published_date: "2026-05-01",
              suggested_tier: "A",
              tier_reason: "Regulatory filing",
            },
            {
              url: "https://www.reuters.com/article/x",
              title: "Reuters",
              snippet: "Wire coverage",
              published_date: null,
              suggested_tier: "B",
              tier_reason: "Independent journalism",
            },
            {
              // Hallucinated URL not in citations — must be dropped.
              url: "https://made-up.example.com/fake",
              title: "Fake",
              snippet: "Should not appear",
              published_date: null,
              suggested_tier: "A",
              tier_reason: "n/a",
            },
          ],
        },
      ],
    });
    const c = ctx();
    const res = await runSearch("nvidia earnings", provider, c);

    expect(res.service).toBe("search");
    expect(res.results.length).toBe(3); // 2 structured + 1 recovered citation
    // Hallucinated (uncited) URL never returned — no unsourced AI claims.
    expect(res.sources).not.toContain("https://made-up.example.com/fake");
    // Tier ranking: SEC (A) first, Reuters (B) next, blog (D) last.
    expect(res.results[0]?.url).toBe("https://www.sec.gov/filing/123");
    expect(res.results[0]?.tier).toBe("A");
    expect(res.results[1]?.tier).toBe("B");
    expect(res.results[2]?.tier).toBe("D");
    // Costs recorded to the ledger for every paid call.
    const totals = c.ledger.totals();
    expect(totals.searchCost).toBeGreaterThan(0);
    expect(totals.aiCost).toBeGreaterThan(0);
  });

  it("returns empty results instead of unsourced claims when nothing is cited", async () => {
    const provider = new MockProvider({ citations: [] });
    const res = await runSearch("ghost query", provider, ctx());
    expect(res.results).toEqual([]);
    expect(res.sources).toEqual([]);
    // The structuring AI call is skipped entirely.
    expect(provider.calls.filter((c) => c === "extract")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VERIFY — all four verdicts through the real pipeline (mocked provider)
// ---------------------------------------------------------------------------

function verifyScript(evidence: unknown[], ambiguity = 0): MockScript {
  return {
    citations: [
      { url: "https://www.sec.gov/filing/1", title: "Primary" },
      { url: "https://www.reuters.com/a", title: "Reuters" },
      { url: "https://blog.example-site.net/b", title: "Blog" },
    ],
    extractQueue: [
      {
        results: [
          { url: "https://www.sec.gov/filing/1", title: "Primary", snippet: "s", published_date: null, suggested_tier: "A", tier_reason: "gov" },
          { url: "https://www.reuters.com/a", title: "Reuters", snippet: "s", published_date: null, suggested_tier: "B", tier_reason: "wire" },
          { url: "https://blog.example-site.net/b", title: "Blog", snippet: "s", published_date: null, suggested_tier: "D", tier_reason: "blog" },
        ],
      },
      { evidence, claim_ambiguity: ambiguity },
    ],
  };
}

async function verdictFor(evidence: unknown[], ambiguity = 0): Promise<VerifyResponse> {
  const provider = new MockProvider(verifyScript(evidence, ambiguity));
  return runVerify("test claim", provider, ctx());
}

describe("VERIFY service verdicts", () => {
  it("can return VERIFIED (primary + independent support)", async () => {
    const res = await verdictFor([
      { source_url: "https://www.sec.gov/filing/1", stance: "supports", statement: "s1", quote: "q", derived_from: null, published_date: "2026-06-01" },
      { source_url: "https://www.reuters.com/a", stance: "supports", statement: "s2", quote: "q", derived_from: null, published_date: "2026-06-02" },
    ]);
    expect(res.verdict).toBe("VERIFIED");
    expect(res.primary_source_found).toBe(true);
    expect(res.supporting_evidence).toHaveLength(2);
    expect(res.contradictory_evidence).toHaveLength(0);
    expect(res.confidence).toBeGreaterThan(0.55);
    expect(res.confidence).toBeLessThanOrEqual(1);
    expect(res.confidence_components.primary_source).toBe(1);
    expect(res.source_count).toBeGreaterThan(0);
  });

  it("can return NOT_VERIFIED (contradictions only)", async () => {
    const res = await verdictFor([
      { source_url: "https://www.sec.gov/filing/1", stance: "contradicts", statement: "c1", quote: "q", derived_from: null, published_date: null },
      { source_url: "https://www.reuters.com/a", stance: "contradicts", statement: "c2", quote: "q", derived_from: null, published_date: null },
    ]);
    expect(res.verdict).toBe("NOT_VERIFIED");
    expect(res.contradictory_evidence).toHaveLength(2);
    expect(res.supporting_evidence).toHaveLength(0);
  });

  it("can return INSUFFICIENT_EVIDENCE (neutral evidence only)", async () => {
    const res = await verdictFor(
      [
        { source_url: "https://www.reuters.com/a", stance: "neutral", statement: "n", quote: null, derived_from: null, published_date: null },
      ],
      0.6,
    );
    expect(res.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("can return CONFLICTING_EVIDENCE (both sides independent)", async () => {
    const res = await verdictFor([
      { source_url: "https://www.sec.gov/filing/1", stance: "supports", statement: "s", quote: "q", derived_from: null, published_date: null },
      { source_url: "https://www.reuters.com/a", stance: "contradicts", statement: "c", quote: "q", derived_from: null, published_date: null },
    ]);
    expect(res.verdict).toBe("CONFLICTING_EVIDENCE");
    expect(res.supporting_evidence).toHaveLength(1);
    expect(res.contradictory_evidence).toHaveLength(1);
  });

  it("does not treat syndicated copies as independent corroboration", async () => {
    // Two supporting items, but both derive from the same upstream origin
    // and neither is a primary source → not enough for VERIFIED.
    const res = await verdictFor([
      { source_url: "https://www.reuters.com/a", stance: "supports", statement: "s1", quote: "q", derived_from: null, published_date: null },
      { source_url: "https://blog.example-site.net/b", stance: "supports", statement: "s2", quote: "q", derived_from: "reuters.com", published_date: null },
    ]);
    expect(res.verdict).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("attacker-controlled ir./news. hosts cannot yield a primary-source VERIFIED", async () => {
    // Single supporting evidence item from an attacker-registered `ir.` host:
    // not tier A → not primary → one non-primary origin is never enough.
    const provider = new MockProvider({
      citations: [{ url: "https://ir.attacker-corp.com/results", title: "Fake IR" }],
      extractQueue: [
        {
          results: [
            { url: "https://ir.attacker-corp.com/results", title: "Fake IR", snippet: "s", published_date: null, suggested_tier: "A", tier_reason: "claims official" },
          ],
        },
        {
          evidence: [
            { source_url: "https://ir.attacker-corp.com/results", stance: "supports", statement: "s", quote: "q", derived_from: null, published_date: "2026-06-01" },
          ],
          claim_ambiguity: 0,
        },
      ],
    });
    const res = await runVerify("attacker corp claim", provider, ctx());
    expect(res.primary_source_found).toBe(false);
    expect(res.verdict).not.toBe("VERIFIED");
  });

  it("returns INSUFFICIENT_EVIDENCE when search finds nothing", async () => {
    const provider = new MockProvider({ citations: [] });
    const res = await runVerify("unfindable claim", provider, ctx());
    expect(res.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(res.source_count).toBe(0);
    expect(res.confidence).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Paid flow integration with the real fulfiller (mock provider)
// ---------------------------------------------------------------------------

describe("paid flow with real services", () => {
  it("verify: 402 → pay → full pipeline result with persisted telemetry", async () => {
    const store = new MemoryTransactionStore();
    const provider = new MockProvider(
      verifyScript([
        { source_url: "https://www.sec.gov/filing/1", stance: "supports", statement: "s", quote: "q", derived_from: null, published_date: "2026-06-01" },
        { source_url: "https://www.reuters.com/a", stance: "supports", statement: "s2", quote: "q", derived_from: null, published_date: "2026-06-02" },
      ]),
    );
    const config = testConfig();
    const app = createApp({
      store,
      config,
      quiet: true,
      fulfiller: createRealFulfiller(config, provider),
    });

    const quote = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "test claim" });
    expect(quote.status).toBe(402);
    const txId = quote.body.transaction_id;

    const pay = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: txId });
    const done = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", pay.body.x_payment_header)
      .send({ claim: "test claim" });

    expect(done.status).toBe(200);
    expect(done.body.result.service).toBe("verify");
    expect(done.body.result.verdict).toBe("VERIFIED");
    expect(done.body.result.confidence_components).toBeDefined();

    const tx = await store.get(txId);
    expect(tx?.status).toBe("COMPLETED");
    expect(tx?.confidenceScore).toBe(done.body.result.confidence);
    expect(tx?.sourceCount).toBe(done.body.result.source_count);
    expect(tx?.actualCost).toBeGreaterThan(0);
  });

  it("read: rejects localhost URL with INVALID_REQUEST and marks tx FAILED", async () => {
    const store = new MemoryTransactionStore();
    const config = testConfig();
    const app = createApp({
      store,
      config,
      quiet: true,
      fulfiller: createRealFulfiller(config, new MockProvider()),
    });

    const quote = await request(app)
      .post(`${BASE}/read`)
      .send({ url: "http://127.0.0.1:8080/internal" });
    expect(quote.status).toBe(402);
    const pay = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: quote.body.transaction_id });
    const done = await request(app)
      .post(`${BASE}/read`)
      .set("X-PAYMENT", pay.body.x_payment_header)
      .send({ url: "http://127.0.0.1:8080/internal" });

    expect(done.status).toBe(400);
    expect(done.body.error.code).toBe("INVALID_REQUEST");
    const tx = await store.get(quote.body.transaction_id);
    expect(tx?.status).toBe("FAILED");
    expect(tx?.errorCode).toBe("INVALID_REQUEST");
  });

  it("read: maps an upstream DNS failure to clean SOURCE_UNAVAILABLE", async () => {
    const store = new MemoryTransactionStore();
    const config = testConfig();
    const app = createApp({
      store,
      config,
      quiet: true,
      fulfiller: createRealFulfiller(config, new MockProvider()),
    });

    const url = "https://does-not-exist.invalid/";
    const quote = await request(app).post(`${BASE}/read`).send({ url });
    expect(quote.status).toBe(402);
    const pay = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: quote.body.transaction_id });
    const done = await request(app)
      .post(`${BASE}/read`)
      .set("X-PAYMENT", pay.body.x_payment_header)
      .send({ url });

    expect(done.status).toBe(502);
    expect(done.body.error).toEqual({
      code: "SOURCE_UNAVAILABLE",
      message: "The source URL could not be fetched.",
    });
    const tx = await store.get(quote.body.transaction_id);
    expect(tx?.status).toBe("FAILED");
    expect(tx?.errorCode).toBe("SOURCE_UNAVAILABLE");
  });

  it.each<SafeFetchFailureKind>([
    "dns",
    "timeout",
    "tls",
    "blocked_redirect",
    "unsupported_content_type",
    "network",
  ])("read: never exposes internal %s failures", async (kind) => {
    await expect(
      fetchReadableContent(
        "https://www.iana.org/domains/reserved",
        ctx(),
        async () => {
          throw new SafeFetchError(kind, `internal ${kind} detail`);
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "SOURCE_UNAVAILABLE",
      message: "The source URL could not be fetched.",
    });
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement on paid calls
// ---------------------------------------------------------------------------

describe("paid-call budget enforcement", () => {
  it("charges actual overage against the budget so later calls see it", async () => {
    const { paidCall } = await import("../services/spend");
    const c = ctx();
    // Estimate 0.01 authorized, actual charge comes back at 0.03.
    await paidCall(c, "ai", 0.01, "over-budget call", async () => ({
      value: 1,
      actualCost: 0.03,
    }));
    // Budget reflects the ACTUAL 0.03, not just the 0.01 estimate.
    expect(c.budget.spent).toBeCloseTo(0.03);
    expect(c.ledger.totals().aiCost).toBeCloseTo(0.03);
  });

  it("records the charge in ledger and budget even when parsing fails, on every retry", async () => {
    const { paidCall, withRetries } = await import("../services/spend");
    const { ChargedCallError } = await import("../providers");
    const c = ctx();
    let attempts = 0;
    await expect(
      withRetries(2, () =>
        paidCall(c, "ai", 0.002, "always-unparseable call", async () => {
          attempts += 1;
          // Simulates: provider charged us, then output failed validation.
          throw new ChargedCallError("bad JSON", 0.004, { model: "mock" });
        }),
      ),
    ).rejects.toBeInstanceOf(ChargedCallError);
    expect(attempts).toBe(3);
    // Every charged-but-failed attempt is in the ledger at ACTUAL cost...
    expect(c.ledger.totals().aiCost).toBeCloseTo(3 * 0.004);
    expect(c.ledger.entries.filter((e) => /charged, output unusable/.test(e.description))).toHaveLength(3);
    // ...and the budget reflects estimate + overage per attempt.
    expect(c.budget.spent).toBeCloseTo(3 * 0.004);
  });

  it("search structuring failure still records the charged cost", async () => {
    const provider = new MockProvider({
      citations: [{ url: "https://www.reuters.com/a", title: "Reuters" }],
      extractQueue: [{ results: "not-an-array" }], // fails zod validation
    });
    const c = ctx();
    await expect(runSearch("query", provider, c)).rejects.toThrow();
    // Web search + every failed structuring attempt were recorded.
    expect(c.ledger.totals().searchCost).toBeGreaterThan(0);
    expect(c.ledger.totals().aiCost).toBeGreaterThan(0);
  });

  it("refuses a call whose estimate exceeds the remaining budget", async () => {
    const { paidCall } = await import("../services/spend");
    const { BudgetExceededError } = await import("../pricing/budget");
    const c = { ...ctx(), budget: new BudgetTracker(0.005) };
    let ran = false;
    await expect(
      paidCall(c, "ai", 0.01, "too expensive", async () => {
        ran = true;
        return { value: 1, actualCost: 0.01 };
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(ran).toBe(false); // never executed
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("enforces the configured request limit on API endpoints", async () => {
    const config = { ...testConfig(), rateLimitMaxRequests: 3 };
    const app = createApp({
      store: new MemoryTransactionStore(),
      config,
      quiet: true,
    });
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).get(`${BASE}/health`);
      codes.push(res.status);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
    expect(codes[4]).toBe(429);
  });
});
