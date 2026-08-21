import type { Agent402Config } from "../config";
import {
  expectedCdpResources,
  fetchCdpMerchantDiscovery,
  normalizeRecipientAddress,
  type MerchantResource,
} from "../monitoring/cdpDiscovery";

type BazaarVisibility = "VISIBLE" | "MISSING" | "UNAVAILABLE";

export type BazaarServiceData = {
  service: string;
  visibility: BazaarVisibility;
  activity: {
    recentCalls: string | null;
    uniquePayers: string | null;
    lastCalledAt: string | null;
  };
};

export type BazaarSnapshot = {
  source: "coinbase_discovery";
  checkedAt: string | null;
  services: BazaarServiceData[];
};

const CACHE_TTL_MS = 60_000;
let cache:
  | {
      key: string;
      expiresAt: number;
      value: BazaarSnapshot;
    }
  | undefined;

function unavailableSnapshot(): BazaarSnapshot {
  return {
    source: "coinbase_discovery",
    checkedAt: null,
    services: ["search", "read", "verify"].map((service) => ({
      service,
      visibility: "UNAVAILABLE",
      activity: {
        recentCalls: null,
        uniquePayers: null,
        lastCalledAt: null,
      },
    })),
  };
}

function toActivity(resource: MerchantResource | undefined): BazaarServiceData["activity"] {
  const quality = resource?.quality;
  return {
    recentCalls:
      typeof quality?.l30DaysTotalCalls === "number"
        ? String(quality.l30DaysTotalCalls)
        : null,
    uniquePayers:
      typeof quality?.l30DaysUniquePayers === "number"
        ? String(quality.l30DaysUniquePayers)
        : null,
    lastCalledAt: typeof quality?.lastCalledAt === "string" ? quality.lastCalledAt : null,
  };
}

/**
 * Read-only cached CDP discovery lookup for the public website. It only calls
 * Coinbase merchant discovery and never touches x402 verify, settle, or
 * payment submission paths.
 */
export async function getBazaarSnapshot(config: Agent402Config): Promise<BazaarSnapshot> {
  const key = `${config.recipientAddress}:${config.publicUrl ?? ""}`;
  if (cache?.key === key && cache.expiresAt > Date.now()) return cache.value;

  let snapshot: BazaarSnapshot;
  try {
    const recipient = normalizeRecipientAddress(config.recipientAddress);
    const expected = expectedCdpResources(config);
    const response = await fetchCdpMerchantDiscovery(
      recipient,
      AbortSignal.timeout(3_000),
    );
    const responseRecipient =
      typeof response.payTo === "string"
        ? normalizeRecipientAddress(response.payTo)
        : recipient;
    snapshot = {
      source: "coinbase_discovery",
      checkedAt: new Date().toISOString(),
      services: expected.map((expectedResource) => {
        const resource =
          responseRecipient === recipient
            ? response.resources?.find(
                (candidate) =>
                  candidate.resource === expectedResource.resourceUrl &&
                  candidate.serviceName === expectedResource.serviceName,
              )
            : undefined;
        return {
          service: expectedResource.service,
          visibility: resource ? "VISIBLE" : "MISSING",
          activity: toActivity(resource),
        };
      }),
    };
  } catch {
    snapshot = unavailableSnapshot();
  }

  cache = { key, expiresAt: Date.now() + CACHE_TTL_MS, value: snapshot };
  return snapshot;
}