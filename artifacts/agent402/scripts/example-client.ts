/**
 * Agent402 example client.
 *
 * Demo mode (default, PAYMENT_MODE=test on the server):
 *   pnpm tsx scripts/example-client.ts verify "Some claim to check"
 *   → quote (402) → test-pay → paid retry → structured result.
 *
 * Testnet mode (server in PAYMENT_MODE=testnet):
 *   PAYER_PRIVATE_KEY=0x… X402_MODE=testnet pnpm tsx scripts/example-client.ts verify "…"
 *   Uses the official x402 client packages to sign a real Base Sepolia USDC
 *   payment (wallet must hold testnet USDC from https://faucet.circle.com).
 *
 * Environment:
 *   AGENT402_URL  base URL (default http://localhost:5000/agent402)
 */

const BASE = process.env["AGENT402_URL"] ?? "http://localhost:5000/agent402";

function bodyFor(service: string, input: string): Record<string, string> {
  if (service === "search") return { query: input };
  if (service === "read") return { url: input };
  return { claim: input };
}

async function demoFlow(service: string, input: string): Promise<void> {
  const url = `${BASE}/api/v1/${service}`;
  const body = JSON.stringify(bodyFor(service, input));
  const headers = { "Content-Type": "application/json" };

  console.log(`→ POST ${url} (no payment)`);
  const quoteRes = await fetch(url, { method: "POST", headers, body });
  console.log(`← ${quoteRes.status}`);
  const quote = (await quoteRes.json()) as Record<string, unknown>;
  if (quoteRes.status !== 402) {
    console.log(JSON.stringify(quote, null, 2));
    return;
  }
  console.log(`  transaction_id: ${quote["transaction_id"]}`);

  console.log("→ simulating payment (test mode)");
  const payRes = await fetch(`${BASE}/api/v1/payments/test-pay`, {
    method: "POST",
    headers,
    body: JSON.stringify({ transaction_id: quote["transaction_id"] }),
  });
  const pay = (await payRes.json()) as Record<string, unknown>;
  if (!payRes.ok) throw new Error(JSON.stringify(pay));
  console.log(`  paid $${pay["amount_usd"]}`);

  console.log("→ retrying with X-PAYMENT header");
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "X-PAYMENT": String(pay["x_payment_header"]) },
    body,
  });
  console.log(`← ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

async function testnetFlow(service: string, input: string): Promise<void> {
  const rawKey = process.env["PAYER_PRIVATE_KEY"];
  if (!rawKey) throw new Error("PAYER_PRIVATE_KEY is required for testnet mode");
  const pk = (rawKey.startsWith("0x") ? rawKey : "0x" + rawKey) as `0x${string}`;
  const [{ wrapFetchWithPayment }, { x402Client }, evmClient, { privateKeyToAccount }] =
    await Promise.all([
      import("@x402/fetch"),
      import("@x402/core/client"),
      import("@x402/evm/exact/client"),
      import("viem/accounts"),
    ]);
  const signer = privateKeyToAccount(pk as `0x${string}`);
  console.log(`Payer wallet: ${signer.address}`);
  const client = new x402Client();
  evmClient.registerExactEvmScheme(client, { signer });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  const url = `${BASE}/api/v1/${service}`;
  console.log(`→ POST ${url} (x402 auto-payment)`);
  const res = await fetchWithPay(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(service, input)),
  });
  console.log(`← ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
}

const service = process.argv[2] ?? "verify";
const input =
  process.argv[3] ?? "The James Webb Space Telescope launched in December 2021";
if (!["search", "read", "verify"].includes(service)) {
  throw new Error(`Unknown service "${service}" — use search | read | verify`);
}

if (process.env["X402_MODE"] === "testnet") {
  await testnetFlow(service, input);
} else {
  await demoFlow(service, input);
}
