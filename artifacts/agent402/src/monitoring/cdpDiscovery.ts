import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { Agent402Config } from "../config";

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_DISCOVERY_PATH = "/platform/v2/x402/discovery/merchant";
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const RECIPIENT_OVERRIDE_ENV = /(?:RECIPIENT|PAY[_-]?TO)/i;
export const CANONICAL_RECIPIENT_ENV = "X402_RECIPIENT_ADDRESS";

export const CDP_DISCOVERY_TIMEOUT_MS = 15_000;
export const CDP_DISCOVERY_SERVICES = ["verify", "search", "read"] as const;
export type CdpDiscoveryService = (typeof CDP_DISCOVERY_SERVICES)[number];

export type MerchantResource = {
  resource?: string;
  serviceName?: string;
  accepts?: Array<{ payTo?: string }>;
  quality?: {
    l30DaysTotalCalls?: number;
    l30DaysUniquePayers?: number;
    lastCalledAt?: string;
  };
};

export type MerchantDiscoveryResponse = {
  payTo?: string;
  resources?: MerchantResource[];
};

export type ExpectedCdpResource = {
  service: CdpDiscoveryService;
  resourceUrl: string;
  serviceName: string;
};

export type CdpDiscoveryMonitorResult =
  | {
      kind: "healthy";
      recipient: string;
      resources: ExpectedCdpResource[];
    }
  | {
      kind: "missing_resources";
      recipient: string;
      missing: ExpectedCdpResource[];
    }
  | {
      kind: "unavailable";
      recipient: string;
      message: string;
    }
  | {
      kind: "configuration_error";
      message: string;
    };

export type MerchantDiscoveryFetcher = (
  recipient: string,
  signal: AbortSignal,
) => Promise<MerchantDiscoveryResponse>;

export function normalizeRecipientAddress(address: string): string {
  const trimmed = address.trim();
  if (!EVM_ADDRESS.test(trimmed) || ZERO_ADDRESS.test(trimmed)) {
    throw new Error(
      "X402_RECIPIENT_ADDRESS must be a non-zero 0x-prefixed EVM address",
    );
  }
  return trimmed.toLowerCase();
}

/**
 * The monitor has no independent recipient configuration. Fail closed if a
 * caller tries to introduce one through a command-line argument or an
 * environment variable other than the application's canonical payment
 * configuration.
 */
export function assertNoRecipientOverride(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (argv.length > 0) {
    throw new Error(
      "CDP discovery monitor does not accept CLI arguments; recipient must come from " +
        `${CANONICAL_RECIPIENT_ENV}, the canonical application payment configuration`,
    );
  }

  const overrides = Object.keys(env).filter(
    (name) =>
      name !== CANONICAL_RECIPIENT_ENV &&
      RECIPIENT_OVERRIDE_ENV.test(name),
  );
  if (overrides.length > 0) {
    throw new Error(
      `Recipient override environment variable(s) are not allowed: ${overrides.join(", ")}. ` +
        `Use ${CANONICAL_RECIPIENT_ENV}, the canonical application payment configuration`,
    );
  }
}

export function expectedCdpResources(
  config: Pick<Agent402Config, "publicUrl">,
): ExpectedCdpResource[] {
  const publicUrl = config.publicUrl?.trim();
  if (!publicUrl) {
    throw new Error(
      "AGENT402_PUBLIC_URL is required to verify canonical CDP resource URLs",
    );
  }

  let base: URL;
  try {
    base = new URL(publicUrl);
  } catch {
    throw new Error("AGENT402_PUBLIC_URL must be an absolute HTTPS URL");
  }
  if (base.protocol !== "https:" || !base.pathname.replace(/\/+$/, "").endsWith("/agent402")) {
    throw new Error(
      "AGENT402_PUBLIC_URL must be an HTTPS canonical Agent402 base URL ending in /agent402",
    );
  }

  const canonicalBase = base.toString().replace(/\/+$/, "");
  return CDP_DISCOVERY_SERVICES.map((service) => ({
    service,
    resourceUrl: `${canonicalBase}/cdp/v1/${service}`,
    serviceName: `402Agent ${service.toUpperCase()}`,
  }));
}

function cdpCredentials(): { apiKeyId: string; apiKeySecret: string } {
  const apiKeyId = process.env["CDP_API_KEY_ID"];
  const apiKeySecret = process.env["CDP_API_KEY_SECRET"];
  if (!apiKeyId || !apiKeySecret) {
    throw new Error("CDP discovery credentials are not configured");
  }
  return { apiKeyId, apiKeySecret };
}

/**
 * Read-only CDP merchant lookup. This only creates a short-lived API JWT for
 * the discovery GET endpoint; it does not touch payment, verification, or
 * settlement APIs.
 */
export async function fetchCdpMerchantDiscovery(
  recipient: string,
  signal: AbortSignal,
): Promise<MerchantDiscoveryResponse> {
  const credentials = cdpCredentials();
  const jwt = await generateJwt({
    ...credentials,
    requestMethod: "GET",
    requestHost: CDP_HOST,
    requestPath: CDP_DISCOVERY_PATH,
  });
  const url = new URL(`https://${CDP_HOST}${CDP_DISCOVERY_PATH}`);
  url.searchParams.set("payTo", recipient);
  url.searchParams.set("limit", "100");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Correlation-Context":
          "sdkLanguage=typescript,source=402agent,sourceVersion=0.1.0",
      },
    });
  } catch (error) {
    throw new Error(
      `Coinbase discovery API is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Coinbase discovery API returned HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as MerchantDiscoveryResponse;
  } catch {
    throw new Error("Coinbase discovery API returned invalid JSON");
  }
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Coinbase discovery API timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resourceMatchesRecipient(resource: MerchantResource, recipient: string): boolean {
  // CDP merchant responses are already filtered by payTo. If accepts metadata
  // is supplied, enforce the same normalized recipient as an additional guard.
  if (!resource.accepts || resource.accepts.length === 0) return true;
  return resource.accepts.some((accept) => {
    if (typeof accept.payTo !== "string") return false;
    try {
      return normalizeRecipientAddress(accept.payTo) === recipient;
    } catch {
      return false;
    }
  });
}

/**
 * Checks all expected CDP resources for the recipient resolved solely from
 * Agent402's canonical runtime config. There is intentionally no address
 * argument or environment override, preventing copied addresses from becoming
 * a second source of truth.
 */
export async function checkCdpMerchantDiscovery(
  config: Pick<Agent402Config, "recipientAddress" | "publicUrl">,
  fetchMerchantDiscovery: MerchantDiscoveryFetcher = fetchCdpMerchantDiscovery,
  timeoutMs = CDP_DISCOVERY_TIMEOUT_MS,
): Promise<CdpDiscoveryMonitorResult> {
  let recipient: string;
  let expected: ExpectedCdpResource[];
  try {
    recipient = normalizeRecipientAddress(config.recipientAddress);
    expected = expectedCdpResources(config);
  } catch (error) {
    return {
      kind: "configuration_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let discovery: MerchantDiscoveryResponse;
  try {
    discovery = await withTimeout(
      (signal) => fetchMerchantDiscovery(recipient, signal),
      timeoutMs,
    );
  } catch (error) {
    return {
      kind: "unavailable",
      recipient,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const responseRecipient =
    typeof discovery.payTo === "string"
      ? (() => {
          try {
            return normalizeRecipientAddress(discovery.payTo);
          } catch {
            return null;
          }
        })()
      : recipient;
  const resources = discovery.resources ?? [];
  const missing = expected.filter((expectedResource) => {
    if (responseRecipient !== recipient) return true;
    return !resources.some(
      (resource) =>
        resource.resource === expectedResource.resourceUrl &&
        resource.serviceName === expectedResource.serviceName &&
        resourceMatchesRecipient(resource, recipient),
    );
  });

  if (missing.length > 0) {
    return { kind: "missing_resources", recipient, missing };
  }
  return { kind: "healthy", recipient, resources: expected };
}