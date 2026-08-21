/**
 * Non-paying CDP Bazaar monitor.
 *
 * This script only calls Coinbase's merchant-discovery GET endpoint. It never
 * creates x402 quotes or touches payment, verify, or settle endpoints.
 */
import { getConfig } from "../src/config";
import {
  assertNoRecipientOverride,
  checkCdpMerchantDiscovery,
  type CdpDiscoveryMonitorResult,
} from "../src/monitoring/cdpDiscovery";

const ALERT_DELIVERY_TIMEOUT_MS = 10_000;

async function sendAlert(result: Exclude<CdpDiscoveryMonitorResult, { kind: "healthy" }>) {
  const webhookUrl = process.env["SMOKE_ALERT_WEBHOOK_URL"];
  if (!webhookUrl) return;

  const detail =
    result.kind === "missing_resources"
      ? `Missing: ${result.missing
          .map((resource) => `${resource.serviceName} (${resource.resourceUrl})`)
          .join(", ")}`
      : result.message;
  const category =
    result.kind === "missing_resources"
      ? "CDP_DISCOVERY_RESOURCE_MISSING"
      : result.kind === "unavailable"
        ? "CDP_DISCOVERY_UNAVAILABLE"
        : "CDP_DISCOVERY_CONFIGURATION_ERROR";
  const text =
    `🚨 *Agent402 CDP discovery monitor failed* (${new Date().toISOString()})\n` +
    `• Category: ${category}\n` +
    `• ${detail}`;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(ALERT_DELIVERY_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error(`  [alert] Webhook returned ${response.status}: ${await response.text()}`);
    } else {
      console.error("  [alert] Discovery notification sent to webhook.");
    }
  } catch (error) {
    console.error(
      `  [alert] Could not reach webhook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main() {
  assertNoRecipientOverride();
  console.log("=== Agent402 CDP discovery monitor (non-paying) ===");
  const result = await checkCdpMerchantDiscovery(getConfig());

  if (result.kind === "healthy") {
    console.log(`  ✓ recipient: ${result.recipient}`);
    for (const resource of result.resources) {
      console.log(`  ✓ ${resource.serviceName}: ${resource.resourceUrl}`);
    }
    return;
  }

  if (result.kind === "missing_resources") {
    console.error(`  ✗ CDP merchant catalog missing ${result.missing.length} expected resource(s).`);
  } else if (result.kind === "unavailable") {
    console.error(`  ✗ CDP discovery API unavailable: ${result.message}`);
  } else {
    console.error(`  ✗ CDP discovery configuration error: ${result.message}`);
  }
  await sendAlert(result);
  process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  const result: CdpDiscoveryMonitorResult = {
    kind: "unavailable",
    recipient: "unavailable",
    message: error instanceof Error ? error.message : String(error),
  };
  console.error(`  ✗ CDP discovery monitor failed unexpectedly: ${result.message}`);
  await sendAlert(result);
  process.exitCode = 1;
});