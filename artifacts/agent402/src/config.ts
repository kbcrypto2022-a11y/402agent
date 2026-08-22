/**
 * Central pricing / profit-protection / payment configuration.
 *
 * All business assumptions live here — do NOT hard-code margins, buffers,
 * or cost caps anywhere else in the application.
 */

export type PaymentMode = "test" | "testnet" | "production";

export const BASE_MAINNET_NETWORK = "eip155:8453";
export const BASE_SEPOLIA_NETWORK = "eip155:84532";
export const BASE_MAINNET_USDC =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/**
 * Coinbase CDP x402 facilitator — supports Base mainnet (eip155:8453).
 * Used as the default when PAYMENT_MODE=production and X402_FACILITATOR_URL
 * is not explicitly set. The x402.org facilitator only supports Base Sepolia
 * and must NOT be used for mainnet.
 */
export const CDP_FACILITATOR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402";

export interface Agent402Config {
  /**
   * "test" (mocked payments, demo mode), "testnet" (real x402 payments in
   * testnet USDC), or "production" (real x402 payments in Base mainnet USDC).
   */
  paymentMode: PaymentMode;
  /** Minimum acceptable gross margin (0–1). Work below this is refused. */
  minGrossMargin: number;
  /** Target gross margin used for pricing (0–1). Must be >= minGrossMargin. */
  defaultTargetMargin: number;
  /** Contingency buffer applied to estimated cost (e.g. 0.25 = +25%). */
  costSafetyBuffer: number;
  /** Absolute cap on total fulfillment cost per request (USD). */
  maxCostPerRequest: number;
  /** Cap on AI spend per request (USD). */
  maxAiCostPerRequest: number;
  /** Cap on search-provider spend per request (USD). */
  maxSearchCostPerRequest: number;
  /** Max retries for any external call. */
  maxRetries: number;
  /** Prices are rounded UP to a multiple of this increment (USD). */
  priceRoundingIncrement: number;
  /** Payment asset + network (CAIP-2) for x402 requirements. */
  paymentAsset: string;
  paymentNetwork: string;
  /** Recipient address for x402 payments (env: X402_RECIPIENT_ADDRESS). */
  recipientAddress: string;
  /** x402 facilitator URL (env: X402_FACILITATOR_URL). */
  facilitatorUrl: string;
  /** Per-service base cost estimates (USD) used before real telemetry exists. */
  serviceCostEstimates: Record<string, number>;
  /** Rate limiting. */
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  /**
   * Canonical public base URL for this Agent402 instance (e.g.
   * "https://api.agent402.com/agent402"). When set, the OpenAPI spec's
   * `servers[].url` and the /api/v1/services discovery endpoints advertise
   * this URL instead of deriving it from the incoming request.
   * Env: AGENT402_PUBLIC_URL. Optional — falls back to request origin when absent.
   */
  publicUrl?: string;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${name}: "${raw}"`);
  }
  return n;
}

function envPaymentMode(): PaymentMode {
  const raw = process.env["PAYMENT_MODE"];
  if (raw === undefined || raw === "" || raw === "test") return "test";
  if (raw === "testnet") return "testnet";
  if (raw === "production") return "production";
  throw new Error(
    `Invalid PAYMENT_MODE "${raw}" — must be "test", "testnet" or "production"`,
  );
}

export function loadConfig(): Agent402Config {
  const paymentMode = envPaymentMode();
  const config: Agent402Config = {
    paymentMode,
    minGrossMargin: envNumber("MIN_GROSS_MARGIN", 0.5),
    defaultTargetMargin: envNumber("DEFAULT_TARGET_MARGIN", 0.6),
    costSafetyBuffer: envNumber("COST_SAFETY_BUFFER", 0.25),
    maxCostPerRequest: envNumber("MAX_COST_PER_REQUEST", 0.25),
    maxAiCostPerRequest: envNumber("MAX_AI_COST_PER_REQUEST", 0.12),
    maxSearchCostPerRequest: envNumber("MAX_SEARCH_COST_PER_REQUEST", 0.12),
    maxRetries: envNumber("MAX_RETRIES", 2),
    priceRoundingIncrement: envNumber("PRICE_ROUNDING_INCREMENT", 0.001),
    paymentAsset:
      paymentMode === "production"
        ? BASE_MAINNET_USDC
        : process.env["X402_PAYMENT_ASSET"] ?? "USDC",
    // CAIP-2 network id per current x402 v2 spec.
    paymentNetwork:
      paymentMode === "production"
        ? BASE_MAINNET_NETWORK
        : process.env["X402_PAYMENT_NETWORK"] ?? BASE_SEPOLIA_NETWORK,
    recipientAddress:
      process.env["X402_RECIPIENT_ADDRESS"] ??
      "0x0000000000000000000000000000000000000000",
    // The facilitator URL is environment-configurable; when unset, production
    // defaults to the CDP facilitator (Base mainnet) and testnet defaults to
    // x402.org (Base Sepolia). Uses || so an empty-string env value is treated
    // as unset, allowing tests to clear the secret with vi.stubEnv("", "").
    facilitatorUrl:
      process.env["X402_FACILITATOR_URL"] ||
      (paymentMode === "production"
        ? CDP_FACILITATOR_URL
        : "https://x402.org/facilitator"),
    // Estimates reflect real provider telemetry: a grounded web search runs
    // ~$0.02–0.05 (tool calls + tokens); VERIFY composes search + reads +
    // evidence analysis.
    serviceCostEstimates: {
      search: envNumber("SEARCH_COST_ESTIMATE", 0.05),
      read: envNumber("READ_COST_ESTIMATE", 0.015),
      verify: envNumber("VERIFY_COST_ESTIMATE", 0.09),
    },
    rateLimitWindowMs: envNumber("RATE_LIMIT_WINDOW_MS", 60_000),
    rateLimitMaxRequests: envNumber("RATE_LIMIT_MAX_REQUESTS", 60),
    publicUrl: process.env["AGENT402_PUBLIC_URL"]?.trim() || undefined,
  };
  validateConfig(config);
  return config;
}

export function validateConfig(c: Agent402Config): void {
  if (c.minGrossMargin < 0 || c.minGrossMargin >= 1) {
    throw new Error("MIN_GROSS_MARGIN must be in [0, 1)");
  }
  if (c.defaultTargetMargin < c.minGrossMargin || c.defaultTargetMargin >= 1) {
    throw new Error(
      "DEFAULT_TARGET_MARGIN must be >= MIN_GROSS_MARGIN and < 1",
    );
  }
  if (c.costSafetyBuffer < 0) {
    throw new Error("COST_SAFETY_BUFFER must be >= 0");
  }
  if (c.maxCostPerRequest <= 0) {
    throw new Error("MAX_COST_PER_REQUEST must be > 0");
  }
  if (c.priceRoundingIncrement <= 0) {
    throw new Error("PRICE_ROUNDING_INCREMENT must be > 0");
  }
  if (c.maxRetries < 0) {
    throw new Error("MAX_RETRIES must be >= 0");
  }
  if (c.paymentMode === "testnet" || c.paymentMode === "production") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.recipientAddress)) {
      throw new Error(
        `PAYMENT_MODE=${c.paymentMode} requires X402_RECIPIENT_ADDRESS to be a valid EVM address`,
      );
    }
    if (/^0x0{40}$/.test(c.recipientAddress)) {
      throw new Error(
        `PAYMENT_MODE=${c.paymentMode} requires a non-zero X402_RECIPIENT_ADDRESS`,
      );
    }
  }
  if (
    c.paymentMode === "production" &&
    c.paymentNetwork !== BASE_MAINNET_NETWORK
  ) {
    throw new Error(
      `PAYMENT_MODE=production requires ${BASE_MAINNET_NETWORK}`,
    );
  }
  if (
    c.paymentMode === "production" &&
    c.paymentAsset.toLowerCase() !== BASE_MAINNET_USDC.toLowerCase()
  ) {
    throw new Error(
      "PAYMENT_MODE=production requires the native Base mainnet USDC asset",
    );
  }
  if ((c.paymentMode === "testnet" || c.paymentMode === "production") && !c.publicUrl) {
    // Not a hard error — the server still works, but external agents will see
    // a request-derived (dev-only) URL in the OpenAPI spec.
    console.warn(
      "[agent402] WARNING: AGENT402_PUBLIC_URL is not set. " +
      "The OpenAPI spec will advertise a request-derived URL, which may be a dev-only address. " +
      "Set AGENT402_PUBLIC_URL to the canonical production URL (e.g. https://api.agent402.com/agent402).",
    );
  }
}

let cached: Agent402Config | null = null;

export function getConfig(): Agent402Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test helper: override config (only used in automated tests). */
export function setConfigForTesting(c: Agent402Config | null): void {
  cached = c;
}
