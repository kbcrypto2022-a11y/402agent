/**
 * Developer API documentation page (server-rendered HTML) and
 * machine-readable service metadata.
 */
import type { Agent402Config } from "../config";
import { buildQuote } from "../pricing/engine";
import type { ServiceName } from "../database/types";
import { presentationStyles, siteNav, statusPill } from "./presentation";

const SERVICES: readonly ServiceName[] = ["search", "read", "verify"] as const;

// ── /.well-known/x402 ────────────────────────────────────────────────────────

/** Convert a USD price to atomic USDC units (6 decimal places). */
function usdToAtomicUsdc(priceUsd: number): string {
  return String(Math.round(priceUsd * 1_000_000));
}

/** Short, machine-readable description for each service used in the well-known document. */
const SERVICE_DESCRIPTIONS: Record<ServiceName, string> = {
  search:
    "Search the web and return current, ranked, source-tiered results for a query. " +
    "Input: { query: string }. " +
    "Output: results[] (title, url, snippet, source_tier), sources[], generated_at. " +
    "Payment: x402 exact USDC.",
  read:
    "Fetch and extract structured content from a public URL. " +
    "Input: { url: string }. " +
    "Output: title, summary, key_points[], extracted_facts[], source_url. " +
    "Payment: x402 exact USDC.",
  verify:
    "Fact-check a claim with evidence-weighted verdicts. " +
    "Input: { claim: string }. " +
    "Output: verdict (VERIFIED | NOT_VERIFIED | INSUFFICIENT_EVIDENCE | CONFLICTING_EVIDENCE), " +
    "confidence, supporting_evidence[], contradictory_evidence[], sources[]. " +
    "Payment: x402 exact USDC.",
};

export type WellKnownX402Accept = {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: 300;
};

export type WellKnownX402Resource = {
  url: string;
  description: string;
  mimeType: "application/json";
  accepts: [WellKnownX402Accept];
};

export type WellKnownX402Document = {
  x402Version: 2;
  resources: WellKnownX402Resource[];
};

/**
 * Generates the canonical x402 service-discovery document for
 * GET /.well-known/x402.
 *
 * Every field is derived from the live Agent402Config and pricing engine —
 * nothing is hard-coded. When config.publicUrl is set the resource URLs
 * advertise the real production address; otherwise they fall back to the
 * request-derived baseUrl so development stays self-consistent.
 */
export function wellKnownX402(
  config: Agent402Config,
  baseUrl: string,
): WellKnownX402Document {
  const resolvedBase = (config.publicUrl ?? baseUrl).replace(/\/+$/, "");
  return {
    x402Version: 2,
    resources: SERVICES.map((service) => {
      const { price } = buildQuote(config, service);
      return {
        url: `${resolvedBase}/api/v1/${service}`,
        description: SERVICE_DESCRIPTIONS[service],
        mimeType: "application/json",
        accepts: [
          {
            scheme: "exact",
            network: config.paymentNetwork,
            asset: config.paymentAsset,
            amount: usdToAtomicUsdc(price),
            payTo: config.recipientAddress,
            maxTimeoutSeconds: 300,
          },
        ],
      };
    }),
  };
}

// ── Canonical services metadata ───────────────────────────────────────────────

export type CanonicalServiceMetadata = {
  service: ServiceName;
  method: "POST";
  url: string;
  price_usd: number;
  input: Record<string, string>;
  output_fields: string[];
};

export type CanonicalServicesMetadata = {
  name: string;
  tagline: string;
  payment: {
    protocol: "x402";
    x402_version: number;
    scheme: "exact";
    asset: string;
    network: string;
    mode: Agent402Config["paymentMode"];
    facilitator: string | null;
    payment_header: string;
    note: string;
  };
  discovery: {
    bazaar_extension: string;
  };
  services: CanonicalServiceMetadata[];
  endpoints: {
    services: string;
    health: string;
    pricing: string;
    docs: string;
    openapi: string;
    /** Present only in local demo mode; never advertised for real x402 payments. */
    test_payment: string | null;
  };
};

export function servicesMetadata(
  config: Agent402Config,
  baseUrl: string,
): CanonicalServicesMetadata {
  const resolvedBase = config.publicUrl ?? baseUrl;
  return {
    name: "Agent402",
    tagline: "High-accuracy intelligence for AI agents",
    payment: {
      protocol: "x402", x402_version: 2, scheme: "exact",
      asset: config.paymentAsset, network: config.paymentNetwork, mode: config.paymentMode,
      facilitator: config.paymentMode === "test" ? null : config.facilitatorUrl,
      payment_header: config.paymentMode === "test" ? "X-PAYMENT" : "PAYMENT-SIGNATURE",
      note: config.paymentMode === "test"
        ? "Demo mode: payments are simulated test tokens, clearly labeled and never mixed with real revenue."
        : config.paymentMode === "production"
          ? "Production payments on Base mainnet USDC. Amounts in the 402 requirements are atomic USDC units."
          : "Testnet payments (no real money). Amounts in the 402 requirements are atomic USDC units.",
    },
    discovery: { bazaar_extension: "402 responses embed the official x402 Bazaar discovery extension." },
    services: SERVICES.map((service) => ({
      service, method: "POST", url: `${resolvedBase}/api/v1/${service}`,
      price_usd: buildQuote(config, service).price,
      input: (service === "search"
        ? { query: "string (1-2000 chars)" }
        : service === "read"
          ? { url: "string (http/https URL)" }
          : { claim: "string (1-4000 chars)" }) as Record<string, string>,
      output_fields: service === "search"
        ? ["results[] (title, url, snippet, source_tier)", "sources[]", "generated_at"]
        : service === "read"
          ? ["title", "summary", "key_points[]", "extracted_facts[]", "source_url"]
          : ["verdict (VERIFIED | NOT_VERIFIED | INSUFFICIENT_EVIDENCE | CONFLICTING_EVIDENCE)", "confidence (0-1)", "supporting_evidence[]", "contradictory_evidence[]", "sources[]"],
    })),
    endpoints: {
      services: `${resolvedBase}/api/v1/services`,
      health: `${resolvedBase}/api/v1/health`, pricing: `${resolvedBase}/api/v1/pricing`,
      docs: `${resolvedBase}/docs`, openapi: `${resolvedBase}/openapi.json`,
      test_payment:
        config.paymentMode === "test"
          ? `${resolvedBase}/api/v1/payments/test-pay`
          : null,
    },
  };
}

export function docsPageHtml(basePath: string, config: Agent402Config): string {
  const isTestnet = config.paymentMode === "testnet";
  const isProduction = config.paymentMode === "production";
  const isRealPayment = isTestnet || isProduction;
  const header = isRealPayment ? "PAYMENT-SIGNATURE" : "X-PAYMENT";
  const modeDescription = isProduction
    ? " (Base mainnet — real USDC payments)"
    : isTestnet
      ? " (Base Sepolia testnet — no real money)"
      : " (demo — simulated payments)";
  const settlementStatus = isProduction
    ? '<td style="color:var(--mint)">AVAILABLE</td><td>Production settlement uses Base mainnet USDC after successful fulfillment.</td>'
    : '<td style="color:var(--muted)">UNAVAILABLE</td><td>Current environment does not claim mainnet availability.</td>';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>402Agent.ai — Developer Documentation</title>
<meta name="description" content="API documentation and quickstart for 402Agent.ai structured web intelligence over x402."/>
<style>${presentationStyles}</style></head><body>${siteNav(basePath)}
<main class="wrap docs-wrap"><p class="back"><a href="${basePath}/">← 402Agent.ai</a></p>
${statusPill(config.paymentMode)}<h1>Developer<br/>documentation</h1>
<p>Structured web intelligence for agents, paid per request via <strong>x402</strong>. Current mode: <code>${config.paymentMode}</code>${modeDescription}.</p>

<h2>Payment flow</h2><ol>
<li><strong>Request without payment.</strong> <code>POST ${basePath}/api/v1/&lt;service&gt;</code> with a JSON body. You receive <code>402 Payment Required</code> and exact requirements — scheme <code>exact</code>, network <code>${config.paymentNetwork}</code>, USDC asset, recipient, amount in atomic units, and a <code>transaction_id</code>.</li>
<li><strong>Pay and retry.</strong> Sign the EIP-3009 authorization and retry the same body with the signed payload in the <code>${header}</code> header. Official client libraries handle this automatically.</li>
<li><strong>Result.</strong> Payment is verified, work runs under a hard cost budget, and settlement happens only after success. The response includes the result, <code>transaction_id</code>, and settlement hash.</li></ol>
<div class="note">Payments bind to the exact service and request body quoted. A completed request can be replayed safely and returns the cached result.</div>

<h2>Endpoints / request contracts</h2>
<h3>POST ${basePath}/api/v1/search</h3><pre>{"query": "latest NVIDIA earnings announcement"}</pre>
<p>Returns ranked results with source tiers.</p><pre>{"transaction_id":"…","result":{"service":"search","results":[{"title":"…","url":"…","snippet":"…","source_tier":1}],"sources":["…"],"generated_at":"…"}}</pre>
<h3>POST ${basePath}/api/v1/read</h3><pre>{"url": "https://example.com/article"}</pre>
<p>Fetches a public page and returns structured extraction.</p><pre>{"result":{"service":"read","title":"…","summary":"…","key_points":["…"],"extracted_facts":["…"],"source_url":"…"}}</pre>
<h3>POST ${basePath}/api/v1/verify</h3><pre>{"claim": "The James Webb telescope launched in December 2021"}</pre>
<p>Returns an evidence-weighed verdict. Thin or contradictory evidence is reported as such.</p><pre>{"result":{"service":"verify","verdict":"VERIFIED","confidence":0.94,"supporting_evidence":["…"],"contradictory_evidence":[],"sources":["…"]}}</pre>

<h2>Free surfaces</h2><table><tr><th>Endpoint</th><th>Description</th></tr>
<tr><td><code>GET ${basePath}/api/v1/health</code></td><td>Service status and payment mode.</td></tr>
<tr><td><code>GET ${basePath}/api/v1/pricing</code></td><td>Live per-request prices.</td></tr>
<tr><td><code>GET ${basePath}/api/v1/services</code></td><td>Canonical machine-readable discovery document. 402 responses also embed Bazaar discovery.</td></tr>
<tr><td><code>GET ${basePath}/openapi.json</code></td><td>OpenAPI 3.1 specification with request and response schemas.</td></tr></table>

<h2>Pricing behavior &amp; errors</h2><ul>
<li>Every request is quoted up front in the 402 response; no price is invented in this document.</li>
<li>Work runs under a hard cost budget. If it cannot be served profitably, the service returns <code>503 UNPROFITABLE_REQUEST</code>.</li>
<li>Common codes include <code>INVALID_REQUEST</code>, <code>PAYMENT_NOT_VERIFIED</code>, <code>PAYMENT_FAILED</code>, <code>RATE_LIMITED</code>, <code>BUDGET_EXCEEDED</code>, and <code>INTERNAL_ERROR</code>.</li></ul>

<h2>Quickstart</h2>${isRealPayment
    ? `<p>Using the official x402 packages and a viem wallet holding ${isProduction ? "Base mainnet" : "Base Sepolia"} USDC:</p><pre>import { wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { privateKeyToAccount } from "viem/accounts";
const signer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const fetchWithPay = wrapFetchWithPayment(fetch, client);
const res = await fetchWithPay("&lt;origin&gt;${basePath}/api/v1/verify", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ claim: "..." }),
});</pre>`
    : `<p>Demo mode: quote, mint a labeled test payment, then retry.</p><pre>const quote = await fetch("${basePath}/api/v1/verify", { method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ claim: "..." }) }).then(r => r.json());
const pay = await fetch("${basePath}/api/v1/payments/test-pay", { method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transaction_id: quote.transaction_id }) }).then(r => r.json());
const result = await fetch("${basePath}/api/v1/verify", { method: "POST",
  headers: { "Content-Type": "application/json", "X-PAYMENT": pay.x_payment_header },
  body: JSON.stringify({ claim: "..." }) }).then(r => r.json());</pre>`}
<p>Canonical discovery: <a href="${basePath}/api/v1/services">GET /api/v1/services</a>. Bazaar discovery is embedded in 402 responses.</p>

<h2>Status &amp; canonical metadata</h2><table><tr><th>Surface</th><th>State</th><th>Use</th></tr>
<tr><td><code>/api/v1/health</code></td><td style="color:var(--mint)">AVAILABLE</td><td>Service status and payment mode.</td></tr>
<tr><td><code>/api/v1/pricing</code></td><td style="color:var(--mint)">AVAILABLE</td><td>Live per-request prices.</td></tr>
<tr><td><code>/api/v1/services</code></td><td style="color:var(--mint)">AVAILABLE</td><td>Canonical discovery metadata.</td></tr>
<tr><td>Production settlement</td>${settlementStatus}</tr></table>
</main><footer class="wrap"><span>402Agent.ai · Intelligence for agents.</span><span><a href="${basePath}/">home</a> · <a href="${basePath}/api/v1/health">status</a></span></footer></body></html>`;
}