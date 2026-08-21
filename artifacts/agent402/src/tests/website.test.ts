import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { MemoryTransactionStore } from "../database/memoryStore";
import { servicesMetadata } from "../api/docs";
import { testConfig } from "./pricing.test";

function websiteApp() {
  const config = testConfig();
  return {
    app: createApp({ store: new MemoryTransactionStore(), config, quiet: true }),
    config,
  };
}

describe("Agent402 public website", () => {
  it("renders the approved homepage and all primary presentation routes", async () => {
    const { app } = websiteApp();
    const pages = [
      ["/agent402/", "Your agent can buy the <em>intelligence</em> it needs."],
      ["/agent402/services", "Composable intelligence services."],
      ["/agent402/payments", "Pay for the request, not the account."],
      ["/agent402/bazaar", "Discoverable paid resources."],
      ["/agent402/status", "Know what your agent can depend on."],
      ["/agent402/docs", "Build against the live contract."],
      ["/agent402/docs/quickstart", "From discovery to structured result."],
    ] as const;

    for (const [path, heading] of pages) {
      const response = await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.type).toContain("html");
      expect(response.text).toContain(heading);
      expect(response.text).toContain('data-testid="link-services"');
      expect(response.text).toContain('data-testid="link-docs"');
      expect(response.text).toContain(
        'data-testid="link-nav-quickstart" href="/agent402/docs/quickstart">Quickstart</a>',
      );
    }
  });

  it("keeps every Quickstart discovery link on the canonical production page", async () => {
    const { app } = websiteApp();
    const homepage = await request(app).get("/agent402/");
    const docs = await request(app).get("/agent402/docs");
    const quickstart = await request(app).get("/agent402/docs/quickstart");
    const canonicalHref = "/agent402/docs/quickstart";

    expect(homepage.text).toContain(
      `data-testid="link-quickstart" href="${canonicalHref}">Read the quickstart</a>`,
    );
    expect(homepage.text).toContain(
      `data-testid="link-nav-quickstart" href="${canonicalHref}">Quickstart</a>`,
    );
    expect(docs.text).toContain(
      `data-testid="link-start-quickstart" href="${canonicalHref}">Start the Quickstart →</a>`,
    );
    expect(quickstart.text).toContain('data-testid="onboarding-search-demo"');
    expect(quickstart.text).toContain('data-testid="quickstart-typescript"');
    expect(quickstart.text).toContain('data-testid="quickstart-python"');
  });

  it("renders service details from canonical metadata instead of invented values", async () => {
    const { app, config } = websiteApp();
    const metadata = servicesMetadata(config, "http://example.test/agent402");
    const search = metadata.services.find((service) => service.service === "search");
    expect(search).toBeDefined();

    const response = await request(app).get("/agent402/services/search");
    expect(response.status).toBe(200);
    expect(response.text).toContain(new URL(search!.url).pathname);
    expect(response.text).toContain(search!.input.query);
    expect(response.text).toContain(search!.output_fields[0]!);
    expect(response.text).toContain(
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 3,
        maximumFractionDigits: 6,
      }).format(search!.price_usd),
    );
  });

  it("uses canonical metadata in the hero protocol example and mobile quickstart cards", async () => {
    const { app, config } = websiteApp();
    const metadata = servicesMetadata(config, "http://example.test/agent402");
    const search = metadata.services.find((service) => service.service === "search");
    expect(search).toBeDefined();

    const home = await request(app).get("/agent402/");
    const quickstart = await request(app).get("/agent402/docs/quickstart");
    const price = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 3,
      maximumFractionDigits: 6,
    }).format(search!.price_usd);

    expect(home.text).toContain(
      "Agents discover a service, receive its price, pay in USDC, and get structured web intelligence—without accounts, subscriptions, or human checkout.",
    );
    expect(home.text).toContain(`HTTP 402 (${price} ${metadata.payment.asset})`);
    expect(home.text).toContain("SEARCH RESULT");
    expect(home.text).toContain("No payment is executed here.");
    expect(quickstart.text).toContain("stacked-mobile-table");
    expect(quickstart.text).toContain('data-label="Source"');
    expect(quickstart.text).toContain('data-label="Use"');
  });

  it("renders metadata-driven TypeScript and Python onboarding without payment side effects", async () => {
    const config = testConfig({
      paymentMode: "testnet",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      publicUrl: "https://402agent.ai/agent402",
    });
    const app = createApp({
      store: new MemoryTransactionStore(),
      config,
      quiet: true,
    });
    const metadata = servicesMetadata(config, "http://example.test/agent402");
    const response = await request(app).get("/agent402/docs/quickstart");

    expect(response.status).toBe(200);
    expect(response.text).toContain('data-testid="onboarding-search-demo"');
    expect(response.text).toContain("End-to-end / live metadata");
    expect(response.text).toContain(metadata.endpoints.services);
    expect(response.text).toContain("HTTP 402");
    expect(response.text).toContain('data-testid="quickstart-typescript"');
    expect(response.text).toContain('data-testid="quickstart-python"');
    expect(response.text).toContain("X-Agent402-Client");
    expect(response.text).toContain("quickstart-typescript");
    expect(response.text).toContain("quickstart-python");
    expect(response.text).toContain("x402HttpxClient");
    expect(response.text).toContain("no payment executed here");
    expect(response.text).not.toContain("Demo-only flow");
  });

  it("renders runnable local demo quickstarts only in test payment mode", async () => {
    const { app, config } = websiteApp();
    const response = await request(app).get("/agent402/docs/quickstart");
    const metadata = servicesMetadata(config, "http://example.test/agent402");

    expect(response.status).toBe(200);
    expect(metadata.endpoints.test_payment).toBe(
      "http://example.test/agent402/api/v1/payments/test-pay",
    );
    expect(response.text).toContain("Demo-only flow");
    expect(response.text).toContain("testPaymentUrl");
    expect(response.text).toContain("payment_url");
    expect(response.text).toContain("DEMO PAY + RETRY");
  });

  it("keeps paid API routes and machine-readable discovery available", async () => {
    const { app } = websiteApp();
    const services = await request(app).get("/agent402/api/v1/services");
    const health = await request(app).get("/agent402/api/v1/health");
    const paid = await request(app)
      .post("/agent402/api/v1/verify")
      .send({ claim: "A factual claim" });

    expect(services.status).toBe(200);
    expect(new URL(services.body.endpoints.services).pathname).toBe(
      "/agent402/api/v1/services",
    );
    expect(new URL(services.body.endpoints.test_payment).pathname).toBe(
      "/agent402/api/v1/payments/test-pay",
    );
    expect(health.status).toBe(200);
    expect(paid.status).toBe(402);
  });
});