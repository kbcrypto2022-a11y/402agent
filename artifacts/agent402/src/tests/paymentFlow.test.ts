import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { MemoryTransactionStore } from "../database/memoryStore";
import { testConfig } from "./pricing.test";

const BASE = "/agent402/api/v1";

function makeApp(store = new MemoryTransactionStore()) {
  return {
    app: createApp({ store, config: testConfig(), quiet: true }),
    store,
  };
}

describe("health & pricing", () => {
  it("GET /health responds ok", async () => {
    const { app } = makeApp();
    const res = await request(app).get(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.payment_mode).toBe("test");
  });

  it("GET /pricing lists profitable prices for all services", async () => {
    const { app } = makeApp();
    const res = await request(app).get(`${BASE}/pricing`);
    expect(res.status).toBe(200);
    expect(res.body.pricing).toHaveLength(3);
    for (const p of res.body.pricing) {
      expect(p.price_usd).toBeGreaterThan(0);
      expect(p.payment_mode).toBe("test");
    }
  });
});

describe("mocked x402 payment flow", () => {
  it("unpaid request returns 402 with payment requirements", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "NVIDIA announced a new GPU today" });
    expect(res.status).toBe(402);
    expect(res.body.x402Version).toBe(2);
    expect(res.body.accepts).toHaveLength(1);
    expect(res.body.accepts[0].asset).toBe("USDC");
    expect(res.body.accepts[0].extra.mode).toBe("test");
    expect(res.body.transaction_id).toMatch(/^tx_/);
  });

  it("records only coarse opted-in attribution for external service usage", async () => {
    const { app, store } = makeApp();
    const attributed = await request(app)
      .post(`${BASE}/search`)
      .set("X-Agent402-Client", "quickstart-typescript")
      .send({ query: "attribution-safe request" });
    expect(attributed.status).toBe(402);

    const tx = await store.get(attributed.body.transaction_id);
    expect(tx?.service).toBe("search");
    expect(tx?.requestSurface).toBe("x402");
    expect(tx?.clientLabel).toBe("quickstart-typescript");

    const invalidLabel = await request(app)
      .post(`${BASE}/verify`)
      .set("X-Agent402-Client", "not a valid label / includes spaces")
      .send({ claim: "safe default attribution" });
    expect(invalidLabel.status).toBe(402);
    const fallback = await store.get(invalidLabel.body.transaction_id);
    expect(fallback?.service).toBe("verify");
    expect(fallback?.clientLabel).toBe("unattributed");
  });

  it("full flow: 402 -> test payment -> verified -> completed with economics", async () => {
    const { app, store } = makeApp();
    const quoteRes = await request(app)
      .post(`${BASE}/search`)
      .send({ query: "latest NVIDIA earnings" });
    expect(quoteRes.status).toBe(402);
    const txId = quoteRes.body.transaction_id;

    const payRes = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: txId });
    expect(payRes.status).toBe(200);
    const header = payRes.body.x_payment_header;

    const doneRes = await request(app)
      .post(`${BASE}/search`)
      .set("X-PAYMENT", header)
      .send({ query: "latest NVIDIA earnings" });
    expect(doneRes.status).toBe(200);
    expect(doneRes.body.transaction_id).toBe(txId);
    expect(doneRes.body.replayed).toBe(false);

    const tx = await store.get(txId);
    expect(tx?.status).toBe("COMPLETED");
    expect(tx?.paymentMode).toBe("test");
    expect(tx?.revenue).toBeCloseTo(tx!.quotedPrice, 9);
    expect(tx?.actualCost).toBeGreaterThan(0);
    expect(tx?.grossProfit).toBeCloseTo(tx!.revenue - tx!.actualCost, 6);
    expect(tx?.grossMargin).toBeGreaterThanOrEqual(0.5); // min margin held
  });

  it("work does not start without payment (payment-before-work)", async () => {
    const { app, store } = makeApp();
    const res = await request(app)
      .post(`${BASE}/read`)
      .send({ url: "https://example.com/article" });
    expect(res.status).toBe(402);
    const tx = await store.get(res.body.transaction_id);
    expect(tx?.status).toBe("PAYMENT_REQUIRED");
    expect(tx?.actualCost).toBe(0); // nothing spent before payment
  });

  it("invalid payment fails", async () => {
    const { app } = makeApp();
    const quoteRes = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "test claim" });
    const txId = quoteRes.body.transaction_id;
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", `x402-test.${txId}.deadbeef.30000.badsignature`)
      .send({ claim: "test claim" });
    expect(res.status).toBe(402);
  });

  it("tampered amount fails signature check", async () => {
    const { app } = makeApp();
    const quoteRes = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "test claim" });
    const txId = quoteRes.body.transaction_id;
    const pay = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: txId });
    const parts = pay.body.x_payment_header.split(".");
    parts[3] = "1"; // lower the paid amount to 1 micro-USD
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", parts.join("."))
      .send({ claim: "test claim" });
    expect(res.status).toBe(402);
  });

  it("duplicate paid request replays the cached result without double work", async () => {
    const { app, store } = makeApp();
    const quoteRes = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "duplicate test" });
    const txId = quoteRes.body.transaction_id;
    const pay = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: txId });
    const header = pay.body.x_payment_header;

    const first = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", header)
      .send({ claim: "duplicate test" });
    expect(first.status).toBe(200);
    const costAfterFirst = (await store.get(txId))!.actualCost;

    const second = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", header)
      .send({ claim: "duplicate test" });
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    // No additional cost incurred, no double charge recorded.
    const tx = await store.get(txId);
    expect(tx?.actualCost).toBeCloseTo(costAfterFirst, 9);
    expect(tx?.revenue).toBeCloseTo(tx!.quotedPrice, 9);
  });

  it("a transaction cannot be test-paid twice", async () => {
    const { app } = makeApp();
    const quoteRes = await request(app)
      .post(`${BASE}/search`)
      .send({ query: "double pay" });
    const txId = quoteRes.body.transaction_id;
    const pay1 = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: txId });
    await request(app)
      .post(`${BASE}/search`)
      .set("X-PAYMENT", pay1.body.x_payment_header)
      .send({ query: "double pay" });
    const pay2 = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: txId });
    expect(pay2.status).toBe(409);
  });

  it("a payment cannot be redeemed for a different request body or service", async () => {
    const { app } = makeApp();
    const quoteRes = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "original claim" });
    const txId = quoteRes.body.transaction_id;
    const pay = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: txId });
    const header = pay.body.x_payment_header;

    // Different body, same service.
    const otherBody = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", header)
      .send({ claim: "a totally different claim" });
    expect(otherBody.status).toBe(402);

    // Different service entirely.
    const otherService = await request(app)
      .post(`${BASE}/search`)
      .set("X-PAYMENT", header)
      .send({ query: "original claim" });
    expect(otherService.status).toBe(402);

    // Original request still works afterwards.
    const ok = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", header)
      .send({ claim: "original claim" });
    expect(ok.status).toBe(200);
  });

  it("malformed requests are rejected with INVALID_REQUEST", async () => {
    const { app } = makeApp();
    const res = await request(app).post(`${BASE}/search`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
    const res2 = await request(app)
      .post(`${BASE}/read`)
      .send({ url: "not-a-url" });
    expect(res2.status).toBe(400);
  });
});

describe("budget enforcement in the flow", () => {
  it("marks the transaction BUDGET_EXCEEDED when steps exceed the hard budget", async () => {
    const { store } = makeApp();
    const { handleServiceRequest } = await import("../api/flow");
    const { issueTestPayment } = await import("../payments/x402/mock");
    const { MockPaymentProcessor } = await import(
      "../payments/x402/mockProcessor"
    );
    const config = testConfig();
    const processor = new MockPaymentProcessor(config);

    const quoted = await handleServiceRequest({
      config,
      store,
      processor,
      service: "verify",
      body: { claim: "expensive" },
    });
    if (quoted.kind !== "payment_required") throw new Error("expected 402");
    const tx = (await store.get(quoted.transactionId))!;
    const payment = issueTestPayment(config, tx.id, tx.quotedPrice);

    const outcome = await handleServiceRequest({
      config,
      store,
      processor,
      service: "verify",
      body: { claim: "expensive" },
      paymentHeader: payment.header,
      stepPlan: [
        { category: "search", cost: 0.005, description: "search" },
        { category: "ai", cost: 10, description: "runaway ai loop" },
      ],
    });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") expect(outcome.code).toBe("BUDGET_EXCEEDED");

    const after = (await store.get(tx.id))!;
    expect(after.status).toBe("BUDGET_EXCEEDED");
    expect(after.errorCode).toBe("BUDGET_EXCEEDED");
    // Only pre-halt spend recorded; the runaway call never executed.
    expect(after.actualCost).toBeCloseTo(0.005, 9);
  });
});
