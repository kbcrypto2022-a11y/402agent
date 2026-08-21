import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent402Config } from "../config";
import {
  assertNoRecipientOverride,
  checkCdpMerchantDiscovery,
  expectedCdpResources,
  fetchCdpMerchantDiscovery,
  normalizeRecipientAddress,
  type MerchantDiscoveryResponse,
} from "../monitoring/cdpDiscovery";

vi.mock("@coinbase/cdp-sdk/auth", () => ({
  generateJwt: vi.fn(async () => "test-discovery-jwt"),
}));

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const WRONG_RECIPIENT = "0x2222222222222222222222222222222222222222";

function config(overrides: Partial<Agent402Config> = {}): Agent402Config {
  return {
    paymentMode: "testnet",
    minGrossMargin: 0.5,
    defaultTargetMargin: 0.6,
    costSafetyBuffer: 0.25,
    maxCostPerRequest: 0.1,
    maxAiCostPerRequest: 0.06,
    maxSearchCostPerRequest: 0.04,
    maxRetries: 2,
    priceRoundingIncrement: 0.001,
    paymentAsset: "USDC",
    paymentNetwork: "eip155:84532",
    recipientAddress: RECIPIENT,
    facilitatorUrl: "https://x402.org/facilitator",
    serviceCostEstimates: { search: 0.008, read: 0.01, verify: 0.024 },
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 1_000,
    publicUrl: "https://402agent.ai/agent402",
    ...overrides,
  };
}

function completeCatalog(
  configured: Agent402Config,
  payTo = RECIPIENT.toLowerCase(),
): MerchantDiscoveryResponse {
  return {
    payTo,
    resources: expectedCdpResources(configured).map((resource) => ({
      resource: resource.resourceUrl,
      serviceName: resource.serviceName,
      accepts: [{ payTo }],
    })),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("CDP discovery monitor", () => {
  it("uses only the canonical configured recipient and normalizes address casing", async () => {
    const configured = config();
    const fetchMerchantDiscovery = vi.fn(async (recipient: string) => {
      expect(recipient).toBe(RECIPIENT.toLowerCase());
      return completeCatalog(configured, RECIPIENT.toUpperCase().replace("0X", "0x"));
    });

    const result = await checkCdpMerchantDiscovery(configured, fetchMerchantDiscovery);

    expect(result).toMatchObject({
      kind: "healthy",
      resources: [
        { service: "verify", serviceName: "402Agent VERIFY" },
        { service: "search", serviceName: "402Agent SEARCH" },
        { service: "read", serviceName: "402Agent READ" },
      ],
    });
    expect(fetchMerchantDiscovery).toHaveBeenCalledTimes(1);
    expect(normalizeRecipientAddress(RECIPIENT.toUpperCase().replace("0X", "0x"))).toBe(
      RECIPIENT.toLowerCase(),
    );
  });

  it("fails closed on CLI or non-canonical environment recipient overrides", () => {
    expect(() =>
      assertNoRecipientOverride(["--recipient", WRONG_RECIPIENT], {
        X402_RECIPIENT_ADDRESS: RECIPIENT,
      }),
    ).toThrow(/does not accept CLI arguments/);

    expect(() =>
      assertNoRecipientOverride([], {
        X402_RECIPIENT_ADDRESS: RECIPIENT,
        CDP_DISCOVERY_PAY_TO: WRONG_RECIPIENT,
      }),
    ).toThrow(/CDP_DISCOVERY_PAY_TO/);

    expect(() =>
      assertNoRecipientOverride([], {
        X402_RECIPIENT_ADDRESS: RECIPIENT,
      }),
    ).not.toThrow();
  });

  it("rejects a malformed canonical recipient before querying Coinbase", async () => {
    const fetchMerchantDiscovery = vi.fn();
    const result = await checkCdpMerchantDiscovery(
      config({ recipientAddress: "not-an-evm-address" }),
      fetchMerchantDiscovery,
    );

    expect(result).toMatchObject({ kind: "configuration_error" });
    expect(fetchMerchantDiscovery).not.toHaveBeenCalled();
  });

  it("rejects missing recipient configuration before querying Coinbase", async () => {
    const fetchMerchantDiscovery = vi.fn();
    const result = await checkCdpMerchantDiscovery(
      config({ recipientAddress: "" }),
      fetchMerchantDiscovery,
    );

    expect(result).toMatchObject({
      kind: "configuration_error",
      message: expect.stringContaining("X402_RECIPIENT_ADDRESS"),
    });
    expect(fetchMerchantDiscovery).not.toHaveBeenCalled();
  });

  it("alerts through a missing-resources outcome unless VERIFY, SEARCH, and READ all match", async () => {
    const configured = config();
    const catalog = completeCatalog(configured);
    catalog.resources = catalog.resources?.filter(
      (resource) => !resource.resource?.endsWith("/read"),
    );

    const result = await checkCdpMerchantDiscovery(configured, async () => catalog);

    expect(result).toMatchObject({
      kind: "missing_resources",
      missing: [
        {
          service: "read",
          resourceUrl: "https://402agent.ai/agent402/cdp/v1/read",
          serviceName: "402Agent READ",
        },
      ],
    });
  });

  it("treats a response for another recipient as missing, not healthy", async () => {
    const configured = config();
    const result = await checkCdpMerchantDiscovery(configured, async () =>
      completeCatalog(configured, WRONG_RECIPIENT),
    );

    expect(result).toMatchObject({
      kind: "missing_resources",
      missing: expect.arrayContaining([
        expect.objectContaining({ service: "verify" }),
        expect.objectContaining({ service: "search" }),
        expect.objectContaining({ service: "read" }),
      ]),
    });
  });

  it("distinguishes Coinbase discovery unavailability from a missing resource", async () => {
    const result = await checkCdpMerchantDiscovery(config(), async () => {
      throw new Error("HTTP 503");
    });

    expect(result).toEqual({
      kind: "unavailable",
      recipient: RECIPIENT.toLowerCase(),
      message: "HTTP 503",
    });
  });

  it("classifies a stalled Coinbase lookup as unavailable instead of hanging", async () => {
    vi.useFakeTimers();
    const fetchMerchantDiscovery = vi.fn(
      async (_recipient: string, signal: AbortSignal): Promise<MerchantDiscoveryResponse> =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ resources: [] }));
        }),
    );
    const resultPromise = checkCdpMerchantDiscovery(
      config(),
      fetchMerchantDiscovery,
      25,
    );

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({
      kind: "unavailable",
      recipient: RECIPIENT.toLowerCase(),
      message: "Coinbase discovery API timed out after 25ms",
    });
    expect(fetchMerchantDiscovery).toHaveBeenCalledTimes(1);
  });

  it("uses one read-only GET for the Coinbase merchant lookup", async () => {
    vi.stubEnv("CDP_API_KEY_ID", "test-key-id");
    vi.stubEnv("CDP_API_KEY_SECRET", "test-key-secret");
    const response = new Response(JSON.stringify({ payTo: RECIPIENT, resources: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const signal = new AbortController().signal;

    await fetchCdpMerchantDiscovery(RECIPIENT, signal);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [request, init] = fetchSpy.mock.calls[0] as [
      URL,
      RequestInit | undefined,
    ];
    expect(request.hostname).toBe("api.cdp.coinbase.com");
    expect(request.pathname).toBe("/platform/v2/x402/discovery/merchant");
    expect(request.searchParams.get("payTo")).toBe(RECIPIENT.toLowerCase());
    expect(init).toMatchObject({ method: "GET", signal });
  });

  it("keeps the monitor out of production startup and in a separate scheduled command", () => {
    const productionWrapper = readFileSync(
      resolve(process.cwd(), "scripts/run-with-smoke.sh"),
      "utf8",
    );
    const scheduledWrapper = readFileSync(
      resolve(process.cwd(), "scripts/run-smoke-scheduled.sh"),
      "utf8",
    );

    expect(productionWrapper).not.toContain("monitor:cdp-discovery");
    expect(scheduledWrapper).toContain(
      "pnpm --filter @workspace/agent402 run monitor:cdp-discovery",
    );
    expect(scheduledWrapper).toContain("DISCOVERY_EXIT_CODE");
  });
});