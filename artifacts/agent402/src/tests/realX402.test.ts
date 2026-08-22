/**
 * Real x402 (testnet-mode) payment processor tests.
 *
 * Uses a fake FacilitatorClient so no network or funds are touched, while
 * exercising the exact wire format of the current official x402 v2 spec:
 * base64 PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers, PaymentPayload with
 * an EIP-3009 authorization, facilitator verify → work → settle.
 */
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
  type DiscoveryExtension,
} from "@x402/extensions/bazaar";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { createApp } from "../app";
import { MemoryTransactionStore } from "../database/memoryStore";
import { RealX402Processor } from "../payments/x402/real";
import type { Agent402Config } from "../config";
import { testConfig } from "./pricing.test";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const NETWORK = "eip155:84532";

function testnetConfig(): Agent402Config {
  return testConfig({
    paymentMode: "testnet",
    recipientAddress: RECIPIENT,
  });
}

function fakeFacilitator(overrides?: {
  verify?: (p: PaymentPayload, r: PaymentRequirements) => VerifyResponse;
  settle?: (p: PaymentPayload, r: PaymentRequirements) => SettleResponse;
}): FacilitatorClient & { verifyCalls: number; settleCalls: number } {
  const fac = {
    verifyCalls: 0,
    settleCalls: 0,
    async verify(
      payload: PaymentPayload,
      requirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
      fac.verifyCalls += 1;
      return (
        overrides?.verify?.(payload, requirements) ?? {
          isValid: true,
          payer: PAYER,
        }
      );
    },
    async settle(
      payload: PaymentPayload,
      requirements: PaymentRequirements,
    ): Promise<SettleResponse> {
      fac.settleCalls += 1;
      return (
        overrides?.settle?.(payload, requirements) ?? {
          success: true,
          transaction: "0xsettlementhash",
          network: NETWORK as `${string}:${string}`,
          payer: PAYER,
        }
      );
    },
    async getSupported(): Promise<SupportedResponse> {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK as `${string}:${string}` }],
        extensions: ["bazaar"],
        signers: {},
      };
    },
  };
  return fac as unknown as FacilitatorClient & {
    verifyCalls: number;
    settleCalls: number;
  };
}

function makeApp(facilitator = fakeFacilitator()) {
  const config = testnetConfig();
  const store = new MemoryTransactionStore();
  const processor = new RealX402Processor(config, facilitator);
  const app = createApp({ store, config, processor, quiet: true });
  return { app, store, config, facilitator };
}

/** Build a client PAYMENT-SIGNATURE header from a 402 response. */
function paymentHeaderFrom(
  res: { headers: Record<string, string>; body: Record<string, unknown> },
  mutate?: (accepted: PaymentRequirements) => void,
  nonceOverride?: string,
): string {
  const required = decodePaymentRequiredHeader(
    res.headers["payment-required"]!,
  );
  const accepted = { ...required.accepts[0]! };
  mutate?.(accepted);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: nonceOverride ?? "0x" + "11".repeat(32),
      },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

/**
 * Build a PAYMENT-SIGNATURE header with the same EIP-3009 nonce but a
 * different outer signature — simulates a client that re-signed the same
 * authorization intent (same nonce, fresh envelope).
 */
function paymentHeaderWithSameNonce(
  res: { headers: Record<string, string>; body: Record<string, unknown> },
  nonce: string,
): string {
  const required = decodePaymentRequiredHeader(
    res.headers["payment-required"]!,
  );
  const accepted = { ...required.accepts[0]! };
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      // Distinct signature bytes — different from the original "ab"-filled one.
      signature: "0x" + "cd".repeat(65),
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce, // same nonce → same authorization_nonce idempotency key
      },
    },
  };
  return encodePaymentSignatureHeader(payload);
}

const BASE = "/agent402/api/v1";
const CDP_BASE = "/agent402/cdp/v1";

describe("testnet mode: real x402 processor", () => {
  it("402 carries a valid PAYMENT-REQUIRED header with atomic USDC amounts", async () => {
    const { app, config } = makeApp();
    const res = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "x402 test claim" });
    expect(res.status).toBe(402);
    expect(res.headers["payment-required"]).toBeTruthy();
    const required = decodePaymentRequiredHeader(
      res.headers["payment-required"]!,
    );
    const req0 = required.accepts[0]!;
    expect(req0.scheme).toBe("exact");
    expect(req0.network).toBe(NETWORK);
    expect(req0.payTo.toLowerCase()).toBe(RECIPIENT.toLowerCase());
    // Amount is atomic USDC (6 decimals) — micro-dollars.
    const tx = res.body.transaction_id as string;
    expect(tx).toMatch(/^tx_/);
    expect(Number(req0.amount)).toBeGreaterThan(0);
    // Bazaar discovery extension embedded.
    expect(JSON.stringify(required.extensions ?? {})).toContain("bazaar");
    const bazaar = required.extensions?.["bazaar"] as
      | DiscoveryExtension
      | undefined;
    expect(bazaar).toBeTruthy();
    expect(validateDiscoveryExtension(bazaar!)).toEqual({ valid: true });
    expect(
      validateDiscoveryExtensionSpec(
        bazaar! as unknown as Record<string, unknown>,
      ),
    ).toEqual({ valid: true });
    expect(res.body.x402Version).toBe(2);
    void config;
  });

  it("full flow: 402 -> pay -> verify -> work -> settle -> recorded", async () => {
    const facilitator = fakeFacilitator();
    const { app, store } = makeApp(facilitator);
    const body = { query: "x402 full flow" };
    const quote = await request(app).post(`${BASE}/search`).send(body);
    expect(quote.status).toBe(402);
    const header = paymentHeaderFrom(quote);

    const done = await request(app)
      .post(`${BASE}/search`)
      .set("PAYMENT-SIGNATURE", header)
      .send(body);
    expect(done.status).toBe(200);
    expect(done.body.settlement.transactionHash).toBe("0xsettlementhash");
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);

    const tx = (await store.get(quote.body.transaction_id))!;
    expect(tx.status).toBe("COMPLETED");
    expect(tx.paymentMode).toBe("testnet");
    expect(tx.paymentStatus).toBe("settled");
    expect(tx.settlementTx).toBe("0xsettlementhash");
    expect(tx.payer).toBe(PAYER);
    expect(tx.revenue).toBeCloseTo(tx.quotedPrice, 9);
    expect(tx.grossProfit).toBeGreaterThan(0);
  });

  it("rejects payment to the wrong recipient", async () => {
    const { app } = makeApp();
    const body = { claim: "wrong recipient" };
    const quote = await request(app).post(`${BASE}/verify`).send(body);
    const header = paymentHeaderFrom(quote, (a) => {
      a.payTo = PAYER; // divert funds
    });
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", header)
      .send(body);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("PAYMENT_NOT_VERIFIED");
  });

  it("rejects an underpaying payment", async () => {
    const { app } = makeApp();
    const body = { claim: "underpay" };
    const quote = await request(app).post(`${BASE}/verify`).send(body);
    const header = paymentHeaderFrom(quote, (a) => {
      a.amount = "1"; // 0.000001 USDC
    });
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", header)
      .send(body);
    expect(res.status).toBe(402);
  });

  it("propagates facilitator verification failure without doing work", async () => {
    const facilitator = fakeFacilitator({
      verify: () => ({ isValid: false, invalidReason: "insufficient_funds" }),
    });
    const { app, store } = makeApp(facilitator);
    const body = { claim: "cannot pay" };
    const quote = await request(app).post(`${BASE}/verify`).send(body);
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", paymentHeaderFrom(quote))
      .send(body);
    expect(res.status).toBe(402);
    const tx = (await store.get(quote.body.transaction_id))!;
    expect(tx.status).toBe("PAYMENT_REQUIRED"); // untouched — no work done
    expect(tx.actualCost).toBe(0);
    expect(facilitator.settleCalls).toBe(0);
  });

  it("settle failure after work: FAILED, zero revenue, loss recorded, no result", async () => {
    const facilitator = fakeFacilitator({
      settle: () => ({
        success: false,
        errorReason: "invalid_signature",
        transaction: "",
        network: NETWORK as `${string}:${string}`,
      }),
    });
    const { app, store } = makeApp(facilitator);
    const body = { query: "settle fails" };
    const quote = await request(app).post(`${BASE}/search`).send(body);
    const res = await request(app)
      .post(`${BASE}/search`)
      .set("PAYMENT-SIGNATURE", paymentHeaderFrom(quote))
      .send(body);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("PAYMENT_FAILED");
    expect(res.body.result).toBeUndefined();

    const tx = (await store.get(quote.body.transaction_id))!;
    expect(tx.status).toBe("FAILED");
    expect(tx.errorCode).toBe("PAYMENT_FAILED");
    expect(tx.revenue).toBe(0); // customer never charged
    expect(tx.grossProfit).toBeLessThan(0); // our loss, flagged on dashboard
  });

  it("replaying the same payment returns the cached result and settles once", async () => {
    const facilitator = fakeFacilitator();
    const { app } = makeApp(facilitator);
    const body = { claim: "idempotent replay" };
    const quote = await request(app).post(`${BASE}/verify`).send(body);
    const header = paymentHeaderFrom(quote);

    const first = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", header)
      .send(body);
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", header)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(facilitator.settleCalls).toBe(1); // never settled twice
  });

  it("same EIP-3009 nonce with a fresh signature blocks double-settlement across transactions", async () => {
    // Scenario: a client successfully pays transaction A with nonce N.
    // Later it obtains a fresh quote (transaction B) and tries to submit
    // the same nonce N with a newly-signed outer envelope. The
    // authorization_nonce UNIQUE constraint must block the second settlement.
    const facilitator = fakeFacilitator();
    const { app } = makeApp(facilitator);
    const body = { claim: "nonce idempotency guard" };
    const SHARED_NONCE = "0x" + "cc".repeat(32);

    // Step 1: quote and pay transaction A with nonce N.
    const quoteA = await request(app).post(`${BASE}/verify`).send(body);
    expect(quoteA.status).toBe(402);
    const headerA = paymentHeaderFrom(quoteA, undefined, SHARED_NONCE);
    const resultA = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", headerA)
      .send(body);
    expect(resultA.status).toBe(200);
    expect(facilitator.settleCalls).toBe(1);

    // Step 2: the client re-quotes the same request (e.g. after losing the
    // transaction id). A fresh PAYMENT_REQUIRED row is created.
    const quoteB = await request(app).post(`${BASE}/verify`).send(body);
    expect(quoteB.status).toBe(402);

    // Step 3: the client re-uses the same EIP-3009 nonce N with a different
    // outer signature against the new quote — simulates a budget wallet that
    // does not generate a fresh nonce for each intent.
    const headerB = paymentHeaderWithSameNonce(quoteB, SHARED_NONCE);
    const resultB = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", headerB)
      .send(body);

    // The authorization_nonce guard must prevent a second settlement.
    expect([402, 409]).toContain(resultB.status);
    // Facilitator was never asked to settle a second time.
    expect(facilitator.settleCalls).toBe(1);
  });

  it("two different payers using the same nonce bytes each settle independently (nonce key is payer-scoped)", async () => {
    // EIP-3009 nonce uniqueness is per (authorizer, nonce) on a specific
    // USDC contract. Two different payer addresses can legitimately use the
    // same 32-byte nonce without conflict on-chain. A key built from the nonce
    // alone would incorrectly block the second payer — so the composite key
    // {network}:{from}:{nonce} must allow both to settle.
    const PAYER_A = "0x2222222222222222222222222222222222222222";
    const PAYER_B = "0x3333333333333333333333333333333333333333";
    const SHARED_NONCE = "0x" + "ee".repeat(32);

    const facilitator = fakeFacilitator();
    const { app } = makeApp(facilitator);

    // Payer A pays for a verify request.
    const quoteA = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "payer-scoped nonce A" });
    expect(quoteA.status).toBe(402);
    const required = decodePaymentRequiredHeader(
      quoteA.headers["payment-required"]!,
    );
    const accepted = { ...required.accepts[0]! };
    const headerA = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted,
      payload: {
        signature: "0x" + "ab".repeat(65),
        authorization: {
          from: PAYER_A,
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 600),
          nonce: SHARED_NONCE,
        },
      },
    });
    const resultA = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", headerA)
      .send({ claim: "payer-scoped nonce A" });
    expect(resultA.status).toBe(200);
    expect(facilitator.settleCalls).toBe(1);

    // Payer B independently pays for a different verify request using the
    // same nonce bytes — this must NOT be blocked by payer A's nonce.
    const quoteB = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "payer-scoped nonce B" });
    expect(quoteB.status).toBe(402);
    const requiredB = decodePaymentRequiredHeader(
      quoteB.headers["payment-required"]!,
    );
    const acceptedB = { ...requiredB.accepts[0]! };
    const headerB = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: requiredB.resource,
      accepted: acceptedB,
      payload: {
        signature: "0x" + "ab".repeat(65),
        authorization: {
          from: PAYER_B, // different payer → different composite key
          to: acceptedB.payTo,
          value: acceptedB.amount,
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 600),
          nonce: SHARED_NONCE, // same nonce bytes — must be allowed
        },
      },
    });
    const resultB = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", headerB)
      .send({ claim: "payer-scoped nonce B" });
    expect(resultB.status).toBe(200); // must NOT be blocked by payer A's nonce
    expect(facilitator.settleCalls).toBe(2); // both settled independently
  });

  it("a payment cannot be redeemed for a different request body", async () => {
    const { app } = makeApp();
    const quote = await request(app)
      .post(`${BASE}/verify`)
      .send({ claim: "original" });
    const header = paymentHeaderFrom(quote);
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", header)
      .send({ claim: "different body" });
    expect(res.status).toBe(402);
  });

  it("test-pay endpoint is disabled in testnet mode", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`${BASE}/payments/test-pay`)
      .send({ transaction_id: "tx_whatever" });
    expect(res.status).toBe(403);
  });

  it("malformed PAYMENT-SIGNATURE headers are rejected cleanly", async () => {
    const { app } = makeApp();
    const body = { claim: "malformed header" };
    await request(app).post(`${BASE}/verify`).send(body);
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("PAYMENT-SIGNATURE", "not-base64-json!!!")
      .send(body);
    expect(res.status).toBe(402);
  });
});

describe("CDP Bazaar route surface", () => {
  const requests = {
    search: { query: "latest x402 news" },
    read: { url: "https://example.com/article" },
    verify: { claim: "x402 uses HTTP 402" },
  };

  function makeCdpApp(facilitator = fakeFacilitator()) {
    const config = {
      ...testnetConfig(),
      publicUrl: "https://402agent.ai/agent402",
    };
    const store = new MemoryTransactionStore();
    const processor = new RealX402Processor(config, facilitator);
    const cdpProcessor = new RealX402Processor(config, facilitator, {
      configuredRequirements: true,
      serviceBrand: "402Agent",
      serviceTag: "402agent",
      maxResourceDescriptionLength: 480,
    });
    const app = createApp({
      store,
      config,
      processor,
      cdpProcessor,
      quiet: true,
    });
    return { app, facilitator };
  }

  for (const service of ["search", "read", "verify"] as const) {
    it(`${service} returns 402 before body validation when unpaid`, async () => {
      const { app } = makeCdpApp();
      const res = await request(app).post(`${CDP_BASE}/${service}`).send();

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeTruthy();
      expect(res.body.x402Version).toBe(2);
    });
  }

  for (const service of ["search", "read", "verify"] as const) {
    it(`${service} returns CDP-ready 402 metadata without a payment`, async () => {
      const config = {
        ...testnetConfig(),
        publicUrl: "https://402agent.ai/agent402",
      };
      const store = new MemoryTransactionStore();
      const processor = new RealX402Processor(config, fakeFacilitator());
      const app = createApp({ store, config, processor, quiet: true });

      const res = await request(app)
        .post(`${CDP_BASE}/${service}`)
        .send(requests[service]);

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeTruthy();
      const required = decodePaymentRequiredHeader(
        res.headers["payment-required"]!,
      );
      expect(required.x402Version).toBe(2);
      expect(required.resource.url).toBe(
        `https://402agent.ai/agent402/cdp/v1/${service}`,
      );
      expect(required.resource.serviceName).toBe(
        `402Agent ${service.toUpperCase()}`,
      );
      expect(required.resource.description?.length).toBeLessThanOrEqual(480);
      expect(required.resource.tags).toContain("402agent");
      const payment = required.accepts[0]!;
      expect(payment.scheme).toBe("exact");
      expect(payment.network).toBe(NETWORK);
      expect(payment.asset).toBe(
        "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      );
      expect(payment.payTo.toLowerCase()).toBe(RECIPIENT.toLowerCase());
      expect(payment.maxTimeoutSeconds).toBe(300);
      expect(payment.extra).toEqual({ name: "USDC", version: "2" });
      expect(JSON.stringify(required.extensions ?? {})).toContain("bazaar");
      const bazaar = required.extensions?.["bazaar"] as
        | DiscoveryExtension
        | undefined;
      expect(bazaar).toBeTruthy();
      expect(validateDiscoveryExtension(bazaar!)).toEqual({ valid: true });
      expect(
        validateDiscoveryExtensionSpec(
          bazaar! as unknown as Record<string, unknown>,
        ),
      ).toEqual({ valid: true });
    });
  }

  for (const service of ["search", "read", "verify"] as const) {
    it(`${service} validates a missing body only after payment verification`, async () => {
      const { app, facilitator } = makeCdpApp();
      const quote = await request(app).post(`${CDP_BASE}/${service}`).send();
      const header = paymentHeaderFrom(quote);

      const paid = await request(app)
        .post(`${CDP_BASE}/${service}`)
        .set("PAYMENT-SIGNATURE", header)
        .send();

      expect(paid.status).toBe(400);
      expect(paid.body.error.code).toBe("INVALID_REQUEST");
      expect(facilitator.verifyCalls).toBe(1);
      expect(facilitator.settleCalls).toBe(0);
    });

    it(`${service} fulfills a valid request after payment verification`, async () => {
      const { app, facilitator } = makeCdpApp();
      const body = requests[service];
      const quote = await request(app).post(`${CDP_BASE}/${service}`).send(body);
      const header = paymentHeaderFrom(quote);

      const paid = await request(app)
        .post(`${CDP_BASE}/${service}`)
        .set("PAYMENT-SIGNATURE", header)
        .send(body);

      expect(paid.status).toBe(200);
      expect(paid.body.result).toBeTruthy();
      expect(facilitator.verifyCalls).toBe(1);
      expect(facilitator.settleCalls).toBe(1);
    });
  }

  it("keeps CDP and x402.org pending quotes isolated in the shared store", async () => {
    const config = {
      ...testnetConfig(),
      publicUrl: "https://402agent.ai/agent402",
    };
    const store = new MemoryTransactionStore();
    const processor = new RealX402Processor(config, fakeFacilitator());
    const app = createApp({ store, config, processor, quiet: true });
    const body = { claim: "the same request on both facilitator surfaces" };

    const x402Quote = await request(app).post(`${BASE}/verify`).send(body);
    const cdpQuote = await request(app).post(`${CDP_BASE}/verify`).send(body);

    const x402Tx = await store.get(x402Quote.body.transaction_id);
    const cdpTx = await store.get(cdpQuote.body.transaction_id);
    expect(x402Tx?.requestHash).toBeTruthy();
    expect(cdpTx?.requestHash).toBeTruthy();
    expect(cdpTx?.requestHash).not.toBe(x402Tx?.requestHash);
  });
});

describe("payment mode gating", () => {
  it("production mode is accepted and uses the real x402 processor", () => {
    // Production mode (Base mainnet) is now a supported payment mode.
    // createApp must not throw; it should produce a functioning app.
    const config = testConfig({
      paymentMode: "production",
      paymentNetwork: "eip155:8453",
      paymentAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      recipientAddress: RECIPIENT,
    });
    expect(() =>
      createApp({ store: new MemoryTransactionStore(), config, quiet: true }),
    ).not.toThrow();
  });

  it("testnet config requires a non-zero recipient address", async () => {
    const { validateConfig } = await import("../config");
    expect(() =>
      validateConfig(testConfig({ paymentMode: "testnet" })),
    ).toThrow(/X402_RECIPIENT_ADDRESS/);
    expect(() => validateConfig(testnetConfig())).not.toThrow();
  });

  it("mock test tokens are rejected in testnet mode", async () => {
    const { app } = makeApp();
    const body = { claim: "mock token in testnet" };
    await request(app).post(`${BASE}/verify`).send(body);
    const res = await request(app)
      .post(`${BASE}/verify`)
      .set("X-PAYMENT", "x402-test.tx_x.nonce.30000.sig")
      .send(body);
    // X-PAYMENT is ignored entirely in testnet mode — a fresh 402 quote.
    expect(res.status).toBe(402);
    expect(res.body.error ?? res.body.x402Version).toBeTruthy();
  });
});

describe("admin dashboard auth", () => {
  it("requires login and accepts the correct password", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "correct-horse");
    vi.stubEnv("SESSION_SECRET", "a-strong-session-secret-for-tests");
    try {
      const { app } = makeApp();
      const unauth = await request(app).get("/agent402/admin");
      expect(unauth.status).toBe(401);

      const badLogin = await request(app)
        .post("/agent402/admin/login")
        .type("form")
        .send({ password: "wrong" });
      expect(badLogin.status).toBe(401);

      const login = await request(app)
        .post("/agent402/admin/login")
        .type("form")
        .send({ password: "correct-horse" });
      expect(login.status).toBe(302);
      const cookie = login.headers["set-cookie"]![0]!.split(";")[0]!;

      const dash = await request(app)
        .get("/agent402/admin")
        .set("Cookie", cookie);
      expect(dash.status).toBe(200);
      expect(dash.text).toContain("AGENT402 OPERATIONS");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is disabled with a clear message when ADMIN_PASSWORD is unset", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "");
    vi.stubEnv("SESSION_SECRET", "a-strong-session-secret-for-tests");
    try {
      const { app } = makeApp();
      const res = await request(app).get("/agent402/admin");
      expect(res.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when SESSION_SECRET is missing or weak — even with a password", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "correct-horse");
    vi.stubEnv("SESSION_SECRET", "");
    try {
      const { app } = makeApp();
      expect((await request(app).get("/agent402/admin")).status).toBe(503);
      const login = await request(app)
        .post("/agent402/admin/login")
        .type("form")
        .send({ password: "correct-horse" });
      expect(login.status).toBe(503); // no session can be issued

      vi.stubEnv("SESSION_SECRET", "short"); // under minimum length
      expect((await request(app).get("/agent402/admin")).status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a cookie forged with the old public fallback key never authenticates", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "correct-horse");
    vi.stubEnv("SESSION_SECRET", "a-strong-session-secret-for-tests");
    try {
      const { app } = makeApp();
      const { createHmac } = await import("node:crypto");
      const exp = Date.now() + 3600_000;
      const forge = (key: string) =>
        `agent402_admin=${exp}.${createHmac("sha256", key).update(`admin.${exp}`).digest("hex")}`;
      for (const key of ["agent402-admin-session", "guessable", ""]) {
        const res = await request(app)
          .get("/agent402/admin")
          .set("Cookie", forge(key));
        expect(res.status).toBe(401);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
