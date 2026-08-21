/**
 * Smoke test for the live x402 payment flow.
 *
 * Runs a real Base Sepolia micro-payment against the running Agent402 server
 * and asserts the response is HTTP 200 with a settlement transaction hash.
 *
 * Usage:
 *   pnpm --filter @workspace/agent402 run smoke
 *
 * Required env:
 *   PAYER_PRIVATE_KEY          — Base Sepolia wallet with testnet USDC
 *
 * Optional env:
 *   AGENT402_URL               — server base URL (default: http://localhost:8090/agent402)
 *   SMOKE_ALERT_WEBHOOK_URL    — Slack / Discord webhook URL; a message is POSTed on failure
 */

const BASE = process.env["AGENT402_URL"] ?? "http://localhost:8090/agent402";
const CLAIM = "The James Webb Space Telescope launched in December 2021";

// Track any tx hash obtained during the run so alerts can include a Basescan link.
let capturedTxHash: string | undefined;

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

/** Send a failure alert to the configured webhook (Slack / Discord compatible). */
async function sendFailureAlert(errorMsg: string): Promise<void> {
  const webhookUrl = process.env["SMOKE_ALERT_WEBHOOK_URL"];
  if (!webhookUrl) return; // no webhook configured — silent

  const timestamp = new Date().toISOString();
  const basescanLine = capturedTxHash
    ? `\n• Basescan: https://sepolia.basescan.org/tx/${capturedTxHash}`
    : "";

  const text =
    `🚨 *Agent402 smoke test FAILED* (${timestamp})\n` +
    `• Server: ${BASE}\n` +
    `• Error: ${errorMsg}` +
    basescanLine;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Slack and Discord both accept { text } at a minimum.
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`  [alert] Webhook returned ${res.status}: ${await res.text()}`);
    } else {
      console.error(`  [alert] Failure notification sent to webhook.`);
    }
  } catch (alertErr) {
    console.error(`  [alert] Could not reach webhook: ${alertErr instanceof Error ? alertErr.message : String(alertErr)}`);
  }
}

async function fail(msg: string): Promise<never> {
  console.error(`  ✗ ${msg}`);
  await sendFailureAlert(msg);
  process.exit(1);
}

async function smoke(): Promise<void> {
  console.log("=== Agent402 smoke test (x402 testnet) ===");
  console.log(`  server : ${BASE}`);

  // ── 0. Pre-flight: check PAYER_PRIVATE_KEY ──────────────────────────────
  const rawKey = process.env["PAYER_PRIVATE_KEY"];
  if (!rawKey) await fail("PAYER_PRIVATE_KEY is not set");
  const pk = (rawKey.startsWith("0x") ? rawKey : "0x" + rawKey) as `0x${string}`;

  // ── 1. Health check ─────────────────────────────────────────────────────
  console.log("\n[1] Health check");
  const healthRes = await fetch(`${BASE}/api/v1/health`);
  if (!healthRes.ok) await fail(`Health returned ${healthRes.status}`);
  const health = (await healthRes.json()) as Record<string, unknown>;
  if (health["status"] !== "ok") await fail(`Health status: ${JSON.stringify(health)}`);
  const mode = health["payment_mode"] as string;
  if (mode !== "testnet") await fail(`Expected payment_mode=testnet, got: ${mode}`);
  pass(`Health ok — payment_mode=${mode}`);

  // ── 2. Confirm 402 is returned before payment ───────────────────────────
  console.log("\n[2] Unauthenticated request → 402");
  const quoteRes = await fetch(`${BASE}/api/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim: CLAIM }),
  });
  if (quoteRes.status !== 402) {
    await fail(`Expected 402 quote, got ${quoteRes.status}: ${await quoteRes.text()}`);
  }
  const quote = (await quoteRes.json()) as Record<string, unknown>;
  if (typeof quote["transaction_id"] !== "string" || !quote["transaction_id"].startsWith("tx_")) {
    await fail(`Missing transaction_id in 402 response: ${JSON.stringify(quote)}`);
  }
  pass(`Got 402 with transaction_id=${quote["transaction_id"]}`);

  // ── 3. x402 auto-pay and retry ──────────────────────────────────────────
  console.log("\n[3] x402 testnet payment");
  const [{ wrapFetchWithPayment }, { x402Client }, evmClient, { privateKeyToAccount }] =
    await Promise.all([
      import("@x402/fetch"),
      import("@x402/core/client"),
      import("@x402/evm/exact/client"),
      import("viem/accounts"),
    ]);
  const signer = privateKeyToAccount(pk);
  console.log(`  payer wallet : ${signer.address}`);
  const client = new x402Client();
  evmClient.registerExactEvmScheme(client, { signer });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const res = await fetchWithPay(`${BASE}/api/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claim: CLAIM }),
  });

  // ── 4. Assert response ──────────────────────────────────────────────────
  console.log("\n[4] Asserting response");
  const body = (await res.json()) as Record<string, unknown>;
  console.log(`  HTTP ${res.status}`);
  console.log(`  body: ${JSON.stringify(body, null, 2)}`);

  if (res.status !== 200) {
    await fail(`Expected HTTP 200, got ${res.status}`);
  }
  pass("HTTP 200");

  const settlement = body["settlement"] as Record<string, unknown> | undefined;
  if (!settlement || typeof settlement["transactionHash"] !== "string") {
    await fail(`Missing settlement.transactionHash in response: ${JSON.stringify(body)}`);
  }
  const txHash = settlement["transactionHash"] as string;
  capturedTxHash = txHash; // capture for potential alert use
  if (!txHash.startsWith("0x")) {
    await fail(`settlement.transactionHash is not a 0x hash: ${txHash}`);
  }
  pass(`settlement.transactionHash=${txHash}`);

  const status = body["status"] as string | undefined;
  if (status !== undefined && status !== "COMPLETED") {
    await fail(`Expected status=COMPLETED, got: ${status}`);
  }
  if (status === "COMPLETED") pass("status=COMPLETED");

  console.log("\n=== SMOKE TEST PASSED ✓ ===");
  console.log(`  Basescan: https://sepolia.basescan.org/tx/${txHash}`);
}

smoke().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\n=== SMOKE TEST FAILED ===");
  console.error(msg);
  await sendFailureAlert(msg);
  process.exit(1);
});
