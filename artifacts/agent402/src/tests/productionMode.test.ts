import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../app";
import {
  BASE_MAINNET_NETWORK,
  BASE_MAINNET_USDC,
  BASE_SEPOLIA_NETWORK,
  CDP_FACILITATOR_URL,
  loadConfig,
  validateConfig,
  type Agent402Config,
} from "../config";
import { MemoryTransactionStore } from "../database/memoryStore";
import { servicesMetadata, docsPageHtml } from "../api/docs";
import { openApiSpec } from "../api/openapi";
import { RealX402Processor } from "../payments/x402/real";
import { statusPill } from "../api/presentation";
import { testConfig } from "./pricing.test";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const BASE = "/agent402/api/v1";

function productionConfig(): Agent402Config {
  return testConfig({
    paymentMode: "production",
    paymentNetwork: BASE_MAINNET_NETWORK,
    paymentAsset: BASE_MAINNET_USDC,
    recipientAddress: RECIPIENT,
    facilitatorUrl: "https://api.cdp.coinbase.com/platform/v2/x402",
    publicUrl: "https://402agent.ai/agent402",
  });
}

function localRequirementsProcessor(config: Agent402Config): RealX402Processor {
  return new RealX402Processor(config, {} as FacilitatorClient, {
    configuredRequirements: true,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production x402 payment mode", () => {
  it("accepts production mode at app startup", () => {
    expect(() =>
      createApp({
        store: new MemoryTransactionStore(),
        config: productionConfig(),
        quiet: true,
      }),
    ).not.toThrow();
  });

  it("pins production configuration to Base mainnet and native USDC", () => {
    vi.stubEnv("PAYMENT_MODE", "production");
    vi.stubEnv("X402_RECIPIENT_ADDRESS", RECIPIENT);
    vi.stubEnv("X402_PAYMENT_NETWORK", BASE_SEPOLIA_NETWORK);
    vi.stubEnv("X402_PAYMENT_ASSET", "USDC");

    const config = loadConfig();

    expect(config.paymentMode).toBe("production");
    expect(config.paymentNetwork).toBe(BASE_MAINNET_NETWORK);
    expect(config.paymentAsset).toBe(BASE_MAINNET_USDC);
    expect(config.recipientAddress).toBe(RECIPIENT);
  });

  it("emits an unpaid READ x402 v2 challenge for Base mainnet USDC", async () => {
    const config = productionConfig();
    const app = createApp({
      store: new MemoryTransactionStore(),
      config,
      processor: localRequirementsProcessor(config),
      quiet: true,
    });

    const response = await request(app)
      .post(`${BASE}/read`)
      .send({ url: "https://example.com/article" });

    expect(response.status).toBe(402);
    expect(response.headers["payment-required"]).toBeTruthy();

    const required = decodePaymentRequiredHeader(
      response.headers["payment-required"]!,
    );
    const accepted = required.accepts[0]!;

    expect(required.x402Version).toBe(2);
    expect(accepted.scheme).toBe("exact");
    expect(accepted.network).toBe(BASE_MAINNET_NETWORK);
    expect(accepted.asset).toBe(BASE_MAINNET_USDC);
    expect(accepted.payTo).toBe(RECIPIENT);
    expect(accepted.amount).toBe("32000");
    expect(response.body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      payTo: RECIPIENT,
      amount: "32000",
    });
  });

  it("labels production metadata as Base mainnet x402", () => {
    const config = productionConfig();
    const metadata = servicesMetadata(config, "https://402agent.ai/agent402");
    const spec = openApiSpec(config, "https://402agent.ai") as {
      info: { description: string; "x-payment-protocol": { note: string } };
      components: {
        schemas: {
          PaymentRequired: { properties: { accepts: { items: { properties: { network: { example: string } } } } } };
          Settlement: { properties: { network: { example: string } } };
        };
      };
    };

    expect(metadata.payment).toMatchObject({
      mode: "production",
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      payment_header: "PAYMENT-SIGNATURE",
    });
    expect(metadata.payment.facilitator).toBe(config.facilitatorUrl);
    expect(spec.info.description).toContain("Base mainnet");
    expect(spec.info["x-payment-protocol"].note).toContain("Base mainnet USDC");
    expect(
      spec.components.schemas.PaymentRequired.properties.accepts.items.properties.network.example,
    ).toBe(BASE_MAINNET_NETWORK);
    expect(spec.components.schemas.Settlement.properties.network.example).toBe(
      BASE_MAINNET_NETWORK,
    );
    expect(docsPageHtml("/agent402", config)).toContain(
      "Base mainnet — real USDC payments",
    );
    expect(statusPill("production")).toContain("x402 production / Base mainnet");
  });

  it("keeps testnet requirements on Base Sepolia", async () => {
    const config = testConfig({
      paymentMode: "testnet",
      recipientAddress: RECIPIENT,
    });
    const app = createApp({
      store: new MemoryTransactionStore(),
      config,
      processor: localRequirementsProcessor(config),
      quiet: true,
    });

    const response = await request(app)
      .post(`${BASE}/read`)
      .send({ url: "https://example.com/article" });
    const required = decodePaymentRequiredHeader(
      response.headers["payment-required"]!,
    );

    expect(response.status).toBe(402);
    expect(required.accepts[0]!.network).toBe(BASE_SEPOLIA_NETWORK);
  });

  it("fails closed for unsupported payment modes", () => {
    vi.stubEnv("PAYMENT_MODE", "mainnet");
    expect(() => loadConfig()).toThrow(
      'Invalid PAYMENT_MODE "mainnet" — must be "test", "testnet" or "production"',
    );
  });
});

// ─── RealX402Processor facilitator initialization ────────────────────────────

describe("RealX402Processor facilitator initialization", () => {
  /** Minimal tx shape needed by requirementsFor — only quotedPrice is accessed. */
  const minTx = { quotedPrice: 0.047 };

  const mockReq = {
    scheme: "exact" as const,
    network: BASE_MAINNET_NETWORK,
    amount: "47000",
    asset: BASE_MAINNET_USDC,
    payTo: RECIPIENT,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };

  /**
   * Create a RealX402Processor whose internal x402ResourceServer methods are
   * spied on so tests can inspect initialization without hitting a real
   * facilitator.
   */
  function makeServerMockedProcessor(
    initImpl: () => Promise<void> = () => Promise.resolve(),
  ) {
    const processor = new RealX402Processor(
      productionConfig(),
      {} as FacilitatorClient,
      {},
    );
    const server = (processor as any).server;
    const initSpy = vi
      .spyOn(server, "initialize")
      .mockImplementation(initImpl);
    const buildSpy = vi
      .spyOn(server, "buildPaymentRequirements")
      .mockResolvedValue([mockReq]);
    return { processor, initSpy, buildSpy };
  }

  it("production loadConfig() defaults to CDP facilitator when X402_FACILITATOR_URL is unset", () => {
    vi.stubEnv("PAYMENT_MODE", "production");
    vi.stubEnv("X402_RECIPIENT_ADDRESS", RECIPIENT);
    vi.stubEnv("X402_FACILITATOR_URL", ""); // empty string treated as unset via ||
    const config = loadConfig();
    expect(config.facilitatorUrl).toBe(CDP_FACILITATOR_URL);
  });

  it("calls server.initialize() before buildPaymentRequirements on first use", async () => {
    const callOrder: string[] = [];
    const { processor } = makeServerMockedProcessor(async () => {
      callOrder.push("init");
    });
    vi
      .spyOn((processor as any).server, "buildPaymentRequirements")
      .mockImplementation(async () => {
        callOrder.push("build");
        return [mockReq];
      });
    await (processor as any).requirementsFor(minTx);
    expect(callOrder).toEqual(["init", "build"]);
  });

  it("calls initialize exactly once across multiple sequential calls", async () => {
    const { processor, initSpy } = makeServerMockedProcessor();
    await (processor as any).requirementsFor(minTx);
    await (processor as any).requirementsFor(minTx);
    expect(initSpy).toHaveBeenCalledOnce();
  });

  it("concurrent first requests share one initialization promise", () => {
    const { processor, initSpy } = makeServerMockedProcessor();
    // Call ensureInitialized twice before the first promise settles.
    const p1 = (processor as any).ensureInitialized();
    const p2 = (processor as any).ensureInitialized();
    // Both must return the SAME Promise object — no duplicate initialize call.
    expect(p1).toBe(p2);
    expect(initSpy).toHaveBeenCalledOnce();
    return p1; // let vitest await resolution
  });

  it("initialization failure propagates as HTTP 502 PAYMENT_FAILED", async () => {
    const { processor } = makeServerMockedProcessor(() =>
      Promise.reject(new Error("Facilitator unreachable")),
    );
    const app = createApp({
      store: new MemoryTransactionStore(),
      config: productionConfig(),
      processor,
      quiet: true,
    });
    const res = await request(app)
      .post(`${BASE}/read`)
      .send({ url: "https://example.com" });
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe("PAYMENT_FAILED");
  });

  it("generates canonical mainnet amounts 157000 / 47000 / 282000 for all three services", async () => {
    // Use loadConfig()-equivalent cost estimates so prices match production reality.
    const config = testConfig({
      paymentMode: "production",
      paymentNetwork: BASE_MAINNET_NETWORK,
      paymentAsset: BASE_MAINNET_USDC,
      recipientAddress: RECIPIENT,
      facilitatorUrl: CDP_FACILITATOR_URL,
      publicUrl: "https://402agent.ai/agent402",
      serviceCostEstimates: { search: 0.05, read: 0.015, verify: 0.09 },
      maxCostPerRequest: 0.25,
    });
    // configuredRequirements: true — builds requirements from config, no
    // facilitator call, so the test is hermetic and fast.
    const processor = new RealX402Processor(
      config,
      {} as FacilitatorClient,
      { configuredRequirements: true },
    );
    const app = createApp({
      store: new MemoryTransactionStore(),
      config,
      processor,
      quiet: true,
    });
    const [search, read, verify] = await Promise.all([
      request(app).post(`${BASE}/search`).send({ query: "probe" }),
      request(app).post(`${BASE}/read`).send({ url: "https://example.com" }),
      request(app).post(`${BASE}/verify`).send({ claim: "probe" }),
    ]);
    expect([search.status, read.status, verify.status]).toEqual([402, 402, 402]);
    expect(search.body.accepts[0]).toMatchObject({
      amount: "157000",
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      payTo: RECIPIENT,
    });
    expect(read.body.accepts[0]).toMatchObject({
      amount: "47000",
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      payTo: RECIPIENT,
    });
    expect(verify.body.accepts[0]).toMatchObject({
      amount: "282000",
      network: BASE_MAINNET_NETWORK,
      asset: BASE_MAINNET_USDC,
      payTo: RECIPIENT,
    });
  });
});

describe("validateConfig: facilitator URL enforcement", () => {
  it("production mode with the canonical CDP URL passes validation", () => {
    const config = productionConfig();
    expect(() => validateConfig(config)).not.toThrow();
    expect(config.facilitatorUrl).toBe(CDP_FACILITATOR_URL);
  });

  it("production mode with a non-CDP HTTPS URL fails closed", () => {
    const config = productionConfig();
    config.facilitatorUrl = "https://rogue-facilitator.example.com/x402";
    expect(() => validateConfig(config)).toThrow(/CDP facilitator/);
  });

  it("testnet mode with an HTTP (non-HTTPS) URL fails closed", () => {
    const config = testConfig({
      paymentMode: "testnet",
      recipientAddress: RECIPIENT,
      facilitatorUrl: "http://insecure.example.com/x402",
    });
    expect(() => validateConfig(config)).toThrow(/HTTPS/);
  });

  it("testnet mode with an HTTPS URL passes validation", () => {
    const config = testConfig({
      paymentMode: "testnet",
      recipientAddress: RECIPIENT,
      facilitatorUrl: "https://x402.org/facilitator",
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("loadConfig() in production defaults to the CDP facilitator URL", () => {
    vi.stubEnv("PAYMENT_MODE", "production");
    vi.stubEnv("X402_RECIPIENT_ADDRESS", RECIPIENT);
    vi.stubEnv("X402_FACILITATOR_URL", "");
    vi.stubEnv("AGENT402_PUBLIC_URL", "https://example.com/agent402");
    vi.stubEnv("ALPACA_API_KEY", "dummy-key");
    vi.stubEnv("ALPACA_SECRET_KEY", "dummy-secret");
    const config = loadConfig();
    expect(config.facilitatorUrl).toBe(CDP_FACILITATOR_URL);
  });
});