/**
 * Regression tests for GET /.well-known/x402 and the root Link header.
 *
 * Invariants:
 * - The well-known document is always derived from the live config and pricing
 *   engine — never from duplicated or hard-coded values.
 * - Resource URLs, amounts, network, and asset must match those returned by
 *   /agent402/api/v1/services so both surfaces cannot silently drift apart.
 * - When publicUrl is configured, no localhost/127.0.0.1 appears.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { MemoryTransactionStore } from "../database/memoryStore";
import { wellKnownX402 } from "../api/docs";
import { testConfig } from "./pricing.test";

const SERVICES = ["search", "read", "verify"] as const;

function makeApp(overrides: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig(overrides);
  return {
    app: createApp({ store: new MemoryTransactionStore(), config, quiet: true }),
    config,
  };
}

describe("GET /.well-known/x402", () => {
  it("returns 200 application/json with x402Version 2", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/.well-known/x402");
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    expect(res.body.x402Version).toBe(2);
  });

  it("lists exactly 3 resources — one per paid service", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/.well-known/x402");
    expect(Array.isArray(res.body.resources)).toBe(true);
    expect(res.body.resources).toHaveLength(3);
    const paths = res.body.resources.map(
      (r: { url: string }) => new URL(r.url).pathname.split("/").pop(),
    );
    expect(paths).toContain("search");
    expect(paths).toContain("read");
    expect(paths).toContain("verify");
  });

  it("every resource carries a valid x402 exact payment requirement", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/.well-known/x402");
    for (const resource of res.body.resources) {
      expect(resource.mimeType).toBe("application/json");
      expect(typeof resource.description).toBe("string");
      expect(resource.description.length).toBeGreaterThan(0);
      expect(Array.isArray(resource.accepts)).toBe(true);
      expect(resource.accepts).toHaveLength(1);
      const accept = resource.accepts[0];
      expect(accept.scheme).toBe("exact");
      expect(accept.network).toBe("eip155:84532");
      expect(Number(accept.amount)).toBeGreaterThan(0);
      expect(typeof accept.payTo).toBe("string");
      expect(accept.maxTimeoutSeconds).toBe(300);
    }
  });

  it("amounts match live service prices — anti-drift guard", async () => {
    // The atomic USDC amounts in /.well-known/x402 must always equal
    // round(price_usd × 1 000 000) from /api/v1/services. If pricing changes,
    // both surfaces change together because they share buildQuote().
    const { app } = makeApp();
    const [wkRes, svcRes] = await Promise.all([
      request(app).get("/.well-known/x402"),
      request(app).get("/agent402/api/v1/services"),
    ]);
    expect(wkRes.status).toBe(200);
    expect(svcRes.status).toBe(200);

    const byService = Object.fromEntries(
      wkRes.body.resources.map((r: { url: string; accepts: { amount: string }[] }) => {
        const svc = new URL(r.url).pathname.split("/").pop()!;
        return [svc, r];
      }),
    );

    for (const svc of svcRes.body.services) {
      const wk = byService[svc.service];
      expect(wk).toBeDefined();
      const atomicActual = Number(wk.accepts[0].amount);
      const atomicExpected = Math.round(svc.price_usd * 1_000_000);
      expect(atomicActual).toBe(atomicExpected);
    }
  });

  it("resource URLs match canonical URLs from /api/v1/services", async () => {
    const { app } = makeApp({ publicUrl: "https://402agent.ai/agent402" });
    const [wkRes, svcRes] = await Promise.all([
      request(app).get("/.well-known/x402"),
      request(app).get("/agent402/api/v1/services"),
    ]);
    const wkUrls = new Set(
      wkRes.body.resources.map((r: { url: string }) => r.url),
    );
    for (const svc of svcRes.body.services) {
      expect(wkUrls.has(svc.url)).toBe(true);
    }
  });

  it("serves the CORS header required for cross-origin agent access", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/.well-known/x402");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("uses publicUrl and contains no localhost when publicUrl is configured", async () => {
    const { app } = makeApp({ publicUrl: "https://402agent.ai/agent402" });
    const res = await request(app).get("/.well-known/x402");
    expect(res.status).toBe(200);
    for (const resource of res.body.resources) {
      expect(resource.url).toContain("402agent.ai");
      expect(resource.url).not.toContain("localhost");
      expect(resource.url).not.toContain("127.0.0.1");
    }
  });

  it("falls back to request-derived URLs in dev when publicUrl is absent", async () => {
    const { app } = makeApp(); // no publicUrl
    const res = await request(app).get("/.well-known/x402");
    expect(res.status).toBe(200);
    for (const resource of res.body.resources) {
      // URL must still be absolute and end with the right service path
      expect(resource.url).toMatch(/\/api\/v1\/(search|read|verify)$/);
    }
  });
});

describe("root HTML Link header", () => {
  it("homepage includes Link: </.well-known/x402>; rel=x402", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/agent402/");
    expect(res.status).toBe(200);
    const link = res.headers["link"] as string | undefined;
    expect(link).toBeDefined();
    expect(link).toContain("/.well-known/x402");
    expect(link).toContain('rel="x402"');
  });

  it("GET /agent402 (no trailing slash) also carries the Link header", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/agent402");
    expect(res.status).toBe(200);
    const link = res.headers["link"] as string | undefined;
    expect(link).toBeDefined();
    expect(link).toContain("/.well-known/x402");
  });

  it("Link header does not appear on non-root website pages", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/agent402/services");
    expect(res.status).toBe(200);
    // Other pages must not accidentally carry this header
    expect(res.headers["link"]).toBeUndefined();
  });
});

describe("GET /openapi.json (root-level discovery)", () => {
  it("returns 200 with application/json", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
  });

  it("is valid OpenAPI 3.1 — has openapi, info, and paths fields", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/openapi.json");
    expect(res.body.openapi).toMatch(/^3\.1\./);
    expect(typeof res.body.info).toBe("object");
    expect(res.body.info.title).toBeTruthy();
    expect(typeof res.body.paths).toBe("object");
  });

  it("contains SEARCH, READ, and VERIFY operations", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/openapi.json");
    const paths = Object.keys(res.body.paths as Record<string, unknown>);
    const hasService = (svc: string) =>
      paths.some((p) => p.endsWith(`/api/v1/${svc}`));
    expect(hasService("search")).toBe(true);
    expect(hasService("read")).toBe(true);
    expect(hasService("verify")).toBe(true);
  });

  it("serves the identical spec as GET /agent402/openapi.json", async () => {
    // Both endpoints must delegate to the same openApiSpec() call so they
    // can never drift from each other.
    // openApiSpec() embeds `new Date().toISOString()` in the /health example
    // response, so two sequential calls can differ by a millisecond. We strip
    // any "time" key from examples before comparing so the test is deterministic
    // while still proving the two routes share the same canonical function.
    const { app } = makeApp({ publicUrl: "https://402agent.ai/agent402" });
    const [root, prefixed] = await Promise.all([
      request(app).get("/openapi.json"),
      request(app).get("/agent402/openapi.json"),
    ]);
    expect(root.status).toBe(200);
    expect(prefixed.status).toBe(200);
    const normalize = (o: unknown): string =>
      JSON.stringify(o, (key, val) => (key === "time" ? undefined : val));
    expect(normalize(root.body)).toBe(normalize(prefixed.body));
  });

  it("uses canonical publicUrl and contains no localhost when publicUrl is set", async () => {
    const { app } = makeApp({ publicUrl: "https://402agent.ai/agent402" });
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain("402agent.ai");
    expect(body).not.toContain("localhost");
    expect(body).not.toContain("127.0.0.1");
  });

  it("falls back to request-derived URLs in dev (no publicUrl)", async () => {
    const { app } = makeApp(); // no publicUrl
    const res = await request(app).get("/openapi.json");
    expect(res.status).toBe(200);
    // Server URL must be absolute
    const servers = res.body.servers as Array<{ url: string }>;
    expect(Array.isArray(servers)).toBe(true);
    expect(servers[0]?.url).toMatch(/^https?:\/\//);
  });

  it("sets CORS header for cross-origin agent access", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/openapi.json");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("wellKnownX402() pure function", () => {
  it("derives all fields from config — network, asset, payTo", () => {
    const config = testConfig({
      paymentNetwork: "eip155:84532",
      paymentAsset: "0xTestAsset",
      recipientAddress: "0x1234567890123456789012345678901234567890",
    });
    const doc = wellKnownX402(config, "https://example.test/agent402");
    expect(doc.x402Version).toBe(2);
    for (const resource of doc.resources) {
      expect(resource.accepts[0].network).toBe("eip155:84532");
      expect(resource.accepts[0].asset).toBe("0xTestAsset");
      expect(resource.accepts[0].payTo).toBe(
        "0x1234567890123456789012345678901234567890",
      );
    }
  });

  it("amounts are positive integers (atomic USDC, 6 decimal places)", () => {
    const config = testConfig();
    const doc = wellKnownX402(config, "https://example.test/agent402");
    for (const resource of doc.resources) {
      const amount = Number(resource.accepts[0].amount);
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
    }
  });

  it("prefers publicUrl over the baseUrl fallback for resource URLs", () => {
    const config = testConfig({ publicUrl: "https://real.example.com/agent402" });
    const doc = wellKnownX402(config, "https://fallback.example.com/agent402");
    for (const resource of doc.resources) {
      expect(resource.url).toContain("real.example.com");
      expect(resource.url).not.toContain("fallback.example.com");
    }
  });

  it("has search, read, verify as the three covered services", () => {
    const config = testConfig();
    const doc = wellKnownX402(config, "https://example.test/agent402");
    const services = doc.resources.map((r) =>
      r.url.split("/").pop(),
    );
    expect(services).toStrictEqual(["search", "read", "verify"]);
  });
});
