import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../app";
import {
  BASE_MAINNET_NETWORK,
  BASE_MAINNET_USDC,
  BASE_SEPOLIA_NETWORK,
  loadConfig,
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