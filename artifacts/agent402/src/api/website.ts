import type { Agent402Config } from "../config";
import {
  servicesMetadata,
  type CanonicalServiceMetadata,
  type CanonicalServicesMetadata,
} from "./docs";
import { presentationStyles, siteNav, statusPill } from "./presentation";
import type { BazaarSnapshot } from "./websiteData";

export type WebsitePage =
  | "home"
  | "services"
  | "service"
  | "payments"
  | "bazaar"
  | "status"
  | "docs"
  | "quickstart";

type WebsitePageOptions = {
  page: WebsitePage;
  basePath: string;
  baseUrl: string;
  config: Agent402Config;
  bazaar: BazaarSnapshot;
  service?: string;
};

const serviceCopy: Record<string, { label: string; description: string }> = {
  search: {
    label: "Find it.",
    description:
      "Discover relevant public-web sources for the next step in an agent workflow.",
  },
  read: {
    label: "Understand it.",
    description:
      "Retrieve eligible public sources as structured content for downstream reasoning.",
  },
  verify: {
    label: "Assess it.",
    description:
      "Evaluate a claim against public evidence with a structured service response.",
  },
};

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 3,
    maximumFractionDigits: 6,
  }).format(value);
}

function protocolExample(
  service: CanonicalServiceMetadata,
  metadata: CanonicalServicesMetadata,
): string {
  return `<div class="trace-example" data-testid="protocol-example">
    <span class="trace-example-label">Live example / canonical quote</span>
    <strong>DISCOVER → HTTP 402 (${escapeHtml(formatPrice(service.price_usd))} ${escapeHtml(metadata.payment.asset)}) → PAY → ${escapeHtml(service.service.toUpperCase())} RESULT</strong>
    <small>No payment is executed here.</small>
  </div>`;
}

function serviceByName(
  metadata: CanonicalServicesMetadata,
  service: string | undefined,
): CanonicalServiceMetadata | undefined {
  return metadata.services.find((candidate) => candidate.service === service);
}

function serviceCard(
  service: CanonicalServiceMetadata,
  basePath: string,
): string {
  const copy = serviceCopy[service.service] ?? {
    label: "Available service.",
    description: "Structured intelligence for autonomous software.",
  };
  return `<article class="catalog-card" data-testid="card-service-${escapeHtml(service.service)}">
    <span class="eyebrow">${escapeHtml(service.service)} / live metadata</span>
    <h2>${escapeHtml(service.service.toUpperCase())}</h2>
    <p><strong style="color:var(--text);font-weight:500">${escapeHtml(copy.label)}</strong><br/>${escapeHtml(copy.description)}</p>
    <div class="svc-end">${escapeHtml(service.method)} ${escapeHtml(shortUrl(service.url))}</div>
    <a class="button" data-testid="link-service-${escapeHtml(service.service)}" href="${basePath}/services/${escapeHtml(service.service)}">View service</a>
  </article>`;
}

function metadataGrid(
  service: CanonicalServiceMetadata,
  metadata: CanonicalServicesMetadata,
): string {
  return `<div class="meta-grid" data-testid="metadata-${escapeHtml(service.service)}">
    <div class="meta-cell"><span class="meta-label">Current price</span><span class="meta-value" data-testid="text-price-${escapeHtml(service.service)}">${escapeHtml(formatPrice(service.price_usd))}</span></div>
    <div class="meta-cell"><span class="meta-label">Payment asset</span><span class="meta-value">${escapeHtml(metadata.payment.asset)}</span></div>
    <div class="meta-cell"><span class="meta-label">Network</span><span class="meta-value">${escapeHtml(metadata.payment.network)}</span></div>
  </div>`;
}

function schemaList(title: string, values: string[]): string {
  return `<section class="panel"><div class="panel-label">${escapeHtml(title)} / canonical metadata</div>${
    values.length > 0
      ? `<ul class="schema-list">${values
          .map((value) => `<li>${escapeHtml(value)}</li>`)
          .join("")}</ul>`
      : `<p class="empty-state">Unavailable</p>`
  }</section>`;
}

function serviceSchema(service: CanonicalServiceMetadata): string {
  const input = Object.entries(service.input).map(
    ([field, description]) => `${field}: ${description}`,
  );
  return `<div class="service-layout">
    <div>
      ${schemaList("Request contract", input)}
    </div>
    <div class="sticky-panel">
      ${schemaList("Response fields", service.output_fields)}
    </div>
  </div>`;
}

function unavailable(value: string | null | undefined): string {
  return value ? escapeHtml(value) : `<span class="unavailable">Unavailable</span>`;
}

function visibilityBadge(value: "VISIBLE" | "MISSING" | "UNAVAILABLE"): string {
  const className =
    value === "VISIBLE" ? "available" : value === "MISSING" ? "missing" : "unavailable";
  return `<span class="badge ${className}">${value}</span>`;
}

function networkSection(
  metadata: CanonicalServicesMetadata,
  snapshot: BazaarSnapshot,
): string {
  const snapshotByService = new Map(
    snapshot.services.map((service) => [service.service, service]),
  );
  const cards = metadata.services
    .map((service) => {
      const bazaar = snapshotByService.get(service.service);
      const visibility = bazaar?.visibility ?? "UNAVAILABLE";
      return `<article class="network-card" data-testid="card-network-${escapeHtml(service.service)}">
        <span class="eyebrow">402Agent ${escapeHtml(service.service.toUpperCase())}</span>
        <h3>${escapeHtml(service.service.toUpperCase())}</h3>
        <div class="status-row"><span>Runtime status</span><span class="status-value" data-testid="status-runtime-${escapeHtml(service.service)}">AVAILABLE</span></div>
        <div class="status-row"><span>Bazaar visibility</span>${visibilityBadge(visibility)}</div>
        <div class="status-row"><span>Current price</span><span class="status-value">${escapeHtml(formatPrice(service.price_usd))}</span></div>
        <div class="status-row"><span>Network</span><span class="status-value">${escapeHtml(metadata.payment.network)}</span></div>
        <div class="status-row"><span>Asset</span><span class="status-value">${escapeHtml(metadata.payment.asset)}</span></div>
        <div class="status-row"><span>Recent calls</span><span class="status-value ${bazaar?.activity.recentCalls ? "" : "unavailable"}">${unavailable(bazaar?.activity.recentCalls)}</span></div>
        <div class="status-row"><span>Unique payers</span><span class="status-value ${bazaar?.activity.uniquePayers ? "" : "unavailable"}">${unavailable(bazaar?.activity.uniquePayers)}</span></div>
        <div class="status-row"><span>Last called</span><span class="status-value ${bazaar?.activity.lastCalledAt ? "" : "unavailable"}">${unavailable(bazaar?.activity.lastCalledAt)}</span></div>
      </article>`;
    })
    .join("");
  return `<section class="section" id="network"><div class="wrap">
    <div class="section-head"><div><h2>02 / 402Agent Network</h2><p class="section-intro">Current service, payment, and discovery state from canonical runtime metadata and Coinbase merchant discovery.</p></div>
    <span class="eyebrow">${snapshot.checkedAt ? `Coinbase checked ${escapeHtml(snapshot.checkedAt)}` : "Coinbase discovery unavailable"}</span></div>
    <div class="network-grid" data-testid="section-agent-network">${cards}</div>
  </div></section>`;
}

function pageShell(
  options: WebsitePageOptions,
  title: string,
  description: string,
  content: string,
): string {
  const canonicalBase = options.config.publicUrl?.replace(/\/+$/, "") ?? "";
  const route = pageRoute(options);
  const canonical = canonicalBase ? `${canonicalBase}${route}` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}"/>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%230a0d10'/%3E%3Cpath d='M14 17h36v30H14z' fill='none' stroke='%23a6d6c1' stroke-width='3'/%3E%3Cpath d='M22 25h20M22 32h20M22 39h13' stroke='%23a6d6c1' stroke-width='3'/%3E%3C/svg%3E"/>
  ${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}"/>` : ""}
  <meta property="og:title" content="${escapeHtml(title)}"/>
  <meta property="og:description" content="${escapeHtml(description)}"/>
  <meta property="og:type" content="website"/>
  <meta name="twitter:card" content="summary"/>
  <style>${presentationStyles}</style>
</head>
<body>
  <header>${siteNav(options.basePath)}</header>
  <main>${content}</main>
  <footer class="wrap"><span>402Agent.ai · Intelligence for agents.</span><span><a href="${options.basePath}/status">status</a> · <a href="${options.basePath}/api/v1/services">service metadata</a> · <a href="${options.basePath}/docs">docs</a></span></footer>
  <script defer>
    fetch("${options.basePath}/api/v1/health").then((response) => response.ok ? response.json() : Promise.reject()).then((health) => {
      document.querySelectorAll("[data-live-health]").forEach((node) => { node.textContent = String(health.status || "Unavailable").toUpperCase(); node.classList.remove("unavailable"); });
    }).catch(() => {
      document.querySelectorAll("[data-live-health]").forEach((node) => { node.textContent = "UNAVAILABLE"; node.classList.add("unavailable"); });
    });
  </script>
</body>
</html>`;
}

function pageRoute(options: WebsitePageOptions): string {
  if (options.page === "home") return "/";
  if (options.page === "service" && options.service) return `/services/${options.service}`;
  if (options.page === "quickstart") return "/docs/quickstart";
  return `/${options.page}`;
}

function pageHeader(
  eyebrow: string,
  title: string,
  description: string,
  back?: string,
): string {
  return `<header class="page-hero"><div class="wrap">${
    back ? `<div class="breadcrumbs">${back}</div>` : ""
  }<span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div></header>`;
}

function homePage(options: WebsitePageOptions, metadata: CanonicalServicesMetadata): string {
  const firstService = metadata.services[0];
  return `${`<header class="hero"><div class="wrap"><div class="hero-grid"><div>
    ${statusPill(metadata.payment.mode)}
    <h1>Your agent can buy the <em>intelligence</em> it needs.</h1>
     <p class="lede">Agents discover a service, receive its price, pay in USDC, and get structured web intelligence—without accounts, subscriptions, or human checkout.</p>
    <div class="hero-actions"><a class="button primary" data-testid="link-explore-services" href="${options.basePath}/services">Explore services</a><a class="button" data-testid="link-quickstart" href="${options.basePath}/docs/quickstart">Read the quickstart</a></div>
  </div><div><div class="hero-note"><strong>Intelligence for agents.</strong>Machine-native discovery, exact payment, and structured results for autonomous software.</div>
     <div class="trace"><span class="dim">01 / DISCOVER</span><br/>→ inspect service metadata and schema<br/><b>02 / 402</b><br/>← exact payment requirements<br/><span class="dim">03 / PAY</span><br/>→ x402-compatible authorization<br/><b>04 / RESULT</b><br/>← structured service output${firstService ? protocolExample(firstService, metadata) : ""}</div>
  </div></div></div></header>`}
  <section class="section" id="services"><div class="wrap">
    <div class="section-head"><div><h2>01 / service catalog</h2><p class="section-intro">Current services derive their technical contract from the canonical discovery document.</p></div><a class="eyebrow" href="${options.basePath}/services">View catalog →</a></div>
    <div class="catalog-grid">${metadata.services.map((service) => serviceCard(service, options.basePath)).join("")}</div>
  </div></section>
  ${networkSection(metadata, options.bazaar)}
  <section class="section"><div class="wrap"><div class="split"><div>
    <div class="section-head"><h2>03 / protocol flow</h2></div>
    <ol class="steps"><li><span>01</span><div><strong>Discover</strong>Read the canonical service metadata and OpenAPI specification.</div></li><li><span>02</span><div><strong>Inspect</strong>Use the current schema, price, asset, and network supplied by the service.</div></li><li><span>03</span><div><strong>Pay</strong>Receive HTTP 402, authorize the exact request requirement, and retry.</div></li><li><span>04</span><div><strong>Result</strong>Continue with the structured response from the paid service.</div></li></ol>
  </div><div class="panel"><div class="panel-label">canonical service / live values</div>${firstService ? metadataGrid(firstService, metadata) : `<p class="empty-state">Unavailable</p>`}<p class="section-intro" style="margin-top:18px">Prices, endpoints, schemas, network, and asset values are read from the live Agent402 service metadata.</p></div></div></div></section>
  <section class="section"><div class="wrap"><div class="section-head"><div><h2>04 / built for discovery</h2><p class="section-intro">REST, OpenAPI, x402, MCP-compatible tooling, and Coinbase Bazaar provide complementary ways for agents and developers to find the same service contract.</p></div></div><div class="inline-links"><a class="button" href="${options.basePath}/docs">Developer docs</a><a class="button" href="${options.basePath}/payments">How payments work</a><a class="button" href="${options.basePath}/bazaar">Coinbase Bazaar</a><a class="button" href="${options.basePath}/openapi.json">OpenAPI JSON</a></div></div></section>`;
}

function servicesPage(options: WebsitePageOptions, metadata: CanonicalServicesMetadata): string {
  return `${pageHeader("Service catalog", "Composable intelligence services.", "Current technical details are supplied by Agent402's canonical service metadata.")}
  <section class="section"><div class="wrap"><div class="catalog-grid">${metadata.services.map((service) => serviceCard(service, options.basePath)).join("")}</div></div></section>
  <section class="section"><div class="wrap"><div class="notice"><strong>Designed to expand.</strong> Future EXTRACT, MONITOR, RESEARCH, COMPARE, and BROWSE services will appear here with the same discovery, payment, and structured-output contract. They are not currently available.</div></div></section>`;
}

function servicePage(
  options: WebsitePageOptions,
  metadata: CanonicalServicesMetadata,
  service: CanonicalServiceMetadata,
): string {
  const copy = serviceCopy[service.service] ?? {
    label: "Available service.",
    description: "Structured intelligence for autonomous software.",
  };
  return `${pageHeader(
    `402Agent ${service.service.toUpperCase()}`,
    `${service.service.toUpperCase()} — ${copy.label}`,
    copy.description,
    `<a href="${options.basePath}/services">Services</a> / ${escapeHtml(service.service.toUpperCase())}`,
  )}
  <section class="section"><div class="wrap">
    ${metadataGrid(service, metadata)}
    <div style="height:24px"></div>
    ${serviceSchema(service)}
  </div></section>
  <section class="section"><div class="wrap"><div class="split"><div><h2>Discover → 402 → Pay → Result</h2><p class="section-intro">Call this canonical endpoint without a payment signature to receive the current HTTP 402 requirement. The client pays the supplied requirement and retries the identical request.</p></div><div class="panel"><div class="panel-label">Canonical endpoint</div><pre class="json">${escapeHtml(service.method)} ${escapeHtml(service.url)}</pre><div class="hero-actions"><a class="button primary" href="${options.basePath}/docs/quickstart">Read the quickstart</a><a class="button" href="${options.basePath}/openapi.json">Inspect OpenAPI</a></div></div></div></div></section>`;
}

function paymentsPage(options: WebsitePageOptions, metadata: CanonicalServicesMetadata): string {
  return `${pageHeader("x402 payments", "Pay for the request, not the account.", "Agent402 uses canonical x402 service metadata to communicate current payment details.")}
  <section class="section"><div class="wrap"><div class="split"><div><ol class="steps"><li><span>01</span><div><strong>Discover</strong>Inspect the service schema and current quote source.</div></li><li><span>02</span><div><strong>Receive 402</strong>The service returns the exact payment requirement for that request.</div></li><li><span>03</span><div><strong>Authorize</strong>An x402-compatible client authorizes the supplied requirement.</div></li><li><span>04</span><div><strong>Retry</strong>The same request returns a structured result after payment verification.</div></li></ol></div><div class="panel"><div class="panel-label">Canonical payment metadata</div><div class="status-row"><span>Protocol</span><span class="status-value">${escapeHtml(metadata.payment.protocol)}</span></div><div class="status-row"><span>Scheme</span><span class="status-value">${escapeHtml(metadata.payment.scheme)}</span></div><div class="status-row"><span>Network</span><span class="status-value">${escapeHtml(metadata.payment.network)}</span></div><div class="status-row"><span>Asset</span><span class="status-value">${escapeHtml(metadata.payment.asset)}</span></div><div class="status-row"><span>Signature header</span><span class="status-value">${escapeHtml(metadata.payment.payment_header)}</span></div></div></div></div></section>
  <section class="section"><div class="wrap"><div class="notice"><strong>Exact requirements are request-specific.</strong> The payment recipient and amount are supplied in the live HTTP 402 response, rather than copied into marketing content.</div></div></section>`;
}

function bazaarPage(options: WebsitePageOptions, metadata: CanonicalServicesMetadata): string {
  return `${pageHeader("Coinbase Bazaar", "Discoverable paid resources.", "Bazaar visibility and activity signals come from Coinbase merchant discovery when that source is available.")}
  ${networkSection(metadata, options.bazaar)}
  <section class="section"><div class="wrap"><div class="split"><div><h2>What agents inspect</h2><p class="section-intro">A discoverable resource provides its identity, route, schema, and payment requirements. The agent decides whether to pay based on those canonical details.</p></div><div class="panel"><div class="panel-label">Discovery source</div><p class="section-intro">${escapeHtml(metadata.discovery.bazaar_extension)}</p><p class="section-intro" style="margin-top:18px">When Coinbase activity values are absent or discovery cannot be reached, this site shows <strong>Unavailable</strong> instead of a zero or estimated value.</p></div></div></div></section>`;
}

function statusPage(options: WebsitePageOptions, metadata: CanonicalServicesMetadata): string {
  return `${pageHeader("Status and trust", "Know what your agent can depend on.", "Runtime status, payment metadata, and discovery signals are presented with their source and unavailable states.")}
  <section class="section"><div class="wrap"><table class="data-table" data-testid="table-status"><thead><tr><th>Surface</th><th>State</th><th>Source</th></tr></thead><tbody>
    <tr><td>Agent402 runtime</td><td><span class="status-value" data-live-health data-testid="status-runtime">LOADING</span></td><td><a href="${options.basePath}/api/v1/health">Health endpoint</a></td></tr>
    <tr><td>Current service pricing</td><td><span class="status-value">AVAILABLE</span></td><td><a href="${options.basePath}/api/v1/pricing">Canonical pricing endpoint</a></td></tr>
    <tr><td>Service contracts</td><td><span class="status-value">AVAILABLE</span></td><td><a href="${options.basePath}/api/v1/services">Canonical service metadata</a></td></tr>
    <tr><td>OpenAPI contract</td><td><span class="status-value">AVAILABLE</span></td><td><a href="${options.basePath}/openapi.json">OpenAPI specification</a></td></tr>
    <tr><td>Coinbase activity metrics</td><td><span class="status-value ${options.bazaar.checkedAt ? "" : "unavailable"}">${options.bazaar.checkedAt ? "AVAILABLE" : "UNAVAILABLE"}</span></td><td>Coinbase merchant discovery</td></tr>
  </tbody></table></div></section>
  ${networkSection(metadata, options.bazaar)}`;
}

function requestSkeleton(service: CanonicalServiceMetadata): string {
  return JSON.stringify(
    Object.fromEntries(Object.keys(service.input).map((field) => [field, "..."])),
    null,
    2,
  );
}

function exampleRequest(service: CanonicalServiceMetadata): Record<string, string> {
  if (service.service === "search") {
    return { query: "latest public developments in battery storage" };
  }
  if (service.service === "read") {
    return { url: "https://example.com/public-source" };
  }
  return { claim: "The James Webb Space Telescope launched in December 2021." };
}

function typeScriptQuickstart(
  metadata: CanonicalServicesMetadata,
): string {
  const source = `import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import * as evmClient from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const metadataUrl = ${JSON.stringify(metadata.endpoints.services)};
const desiredService = (process.env.AGENT402_SERVICE ?? "search").toLowerCase();
const metadataResponse = await fetch(metadataUrl);
if (!metadataResponse.ok) throw new Error("Agent402 metadata unavailable");
const metadata = await metadataResponse.json();

// Choose SEARCH, READ, or VERIFY from live metadata — never hard-code a URL,
// price, network, asset, recipient, or request method.
const target = metadata.services.find((item: { service: string }) =>
  item.service === desiredService,
);
if (!target) throw new Error(\`Unknown Agent402 service: \${desiredService}\`);

const inputs: Record<string, Record<string, string>> = {
  search: { query: "latest public developments in battery storage" },
  read: { url: "https://example.com/public-source" },
  verify: { claim: "The James Webb Space Telescope launched in December 2021." },
};
const body = JSON.stringify(inputs[target.service]);
const request = {
  method: target.method,
  headers: {
    "Content-Type": "application/json",
    // Optional aggregate attribution, not an API key or identity.
    "X-Agent402-Client": "quickstart-typescript",
  },
  body,
};

const signer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as \`0x\${string}\`);
const client = new x402Client();
evmClient.registerExactEvmScheme(client, { signer });

// The wrapper receives HTTP 402, signs its exact requirements, and retries
// this unchanged URL + method + body automatically.
const paidFetch = wrapFetchWithPayment(async (url, init) => {
  const response = await fetch(url, init);
  if (response.status === 402) {
    const requirement = await response.clone().json();
    console.log("HTTP 402 received", {
      service: target.service,
      advertised_price_usd: target.price_usd,
      asset: metadata.payment.asset,
      network: metadata.payment.network,
      transaction_id: requirement.transaction_id,
    });
  }
  return response;
}, client);

const response = await paidFetch(target.url, request);
if (!response.ok) throw new Error(\`Agent402 returned HTTP \${response.status}\`);
console.log(JSON.stringify(await response.json(), null, 2));`;
  return `<pre id="quickstart-typescript" data-testid="quickstart-typescript"><code>${escapeHtml(source)}</code></pre>`;
}

function pythonQuickstart(metadata: CanonicalServicesMetadata): string {
  const source = `# pip install x402 httpx eth-account
import asyncio
import json
import os

import httpx
from eth_account import Account
from x402 import x402Client
from x402.http.clients import x402HttpxClient
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client

METADATA_URL = ${JSON.stringify(metadata.endpoints.services)}
INPUTS = {
    "search": {"query": "latest public developments in battery storage"},
    "read": {"url": "https://example.com/public-source"},
    "verify": {"claim": "The James Webb Space Telescope launched in December 2021."},
}

async def main():
    # Discover the live endpoints, price, schema, asset, and network first.
    async with httpx.AsyncClient(timeout=30) as public_http:
        response = await public_http.get(METADATA_URL)
        response.raise_for_status()
        metadata = response.json()

    desired_service = os.getenv("AGENT402_SERVICE", "search").lower()
    target = next(
        (item for item in metadata["services"] if item["service"] == desired_service),
        None,
    )
    if target is None or desired_service not in INPUTS:
        raise ValueError(f"Unknown Agent402 service: {desired_service}")

    payer = Account.from_key(os.environ["PAYER_PRIVATE_KEY"])
    client = x402Client()
    register_exact_evm_client(client, EthAccountSigner(payer))

    # x402HttpxClient handles HTTP 402: it reads the exact requirement,
    # authorizes payment, and retries the identical request automatically.
    async with x402HttpxClient(client) as paid_http:
        response = await paid_http.request(
            target["method"],
            target["url"],
            json=INPUTS[desired_service],
            headers={
                # Optional aggregate attribution, not an API key or identity.
                "X-Agent402-Client": "quickstart-python",
            },
        )
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))

if __name__ == "__main__":
    asyncio.run(main())`;
  return `<pre id="quickstart-python" data-testid="quickstart-python"><code>${escapeHtml(source)}</code></pre>`;
}

function demoTypeScriptQuickstart(metadata: CanonicalServicesMetadata): string {
  const source = `const metadataUrl = ${JSON.stringify(metadata.endpoints.services)};
const desiredService = (process.env.AGENT402_SERVICE ?? "search").toLowerCase();
const metadata = await fetch(metadataUrl).then((response) => response.json());
const target = metadata.services.find((item: { service: string }) =>
  item.service === desiredService,
);
if (!target) throw new Error(\`Unknown Agent402 service: \${desiredService}\`);

const inputs: Record<string, Record<string, string>> = {
  search: { query: "latest public developments in battery storage" },
  read: { url: "https://example.com/public-source" },
  verify: { claim: "The James Webb Space Telescope launched in December 2021." },
};
const body = JSON.stringify(inputs[target.service]);
const request = {
  method: target.method,
  headers: {
    "Content-Type": "application/json",
    "X-Agent402-Client": "quickstart-typescript",
  },
  body,
};

// Demo mode still returns HTTP 402. It then issues a clearly labeled local
// test payment; no wallet, network, or real funds are used.
const quote = await fetch(target.url, request);
if (quote.status !== 402) throw new Error(\`Expected HTTP 402, got \${quote.status}\`);
const requirement = await quote.json();
const testPaymentUrl = metadata.endpoints.test_payment;
if (!testPaymentUrl) throw new Error("Test payment endpoint unavailable");
const payment = await fetch(testPaymentUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ transaction_id: requirement.transaction_id }),
}).then((response) => response.json());

const response = await fetch(target.url, {
  ...request,
  headers: {
    ...request.headers,
    [metadata.payment.payment_header]: payment.x_payment_header,
  },
});
if (!response.ok) throw new Error(\`Agent402 returned HTTP \${response.status}\`);
console.log(JSON.stringify(await response.json(), null, 2));`;
  return `<pre id="quickstart-typescript" data-testid="quickstart-typescript"><code>${escapeHtml(source)}</code></pre>`;
}

function demoPythonQuickstart(metadata: CanonicalServicesMetadata): string {
  const source = `# pip install httpx
import asyncio
import json
import os

import httpx

METADATA_URL = ${JSON.stringify(metadata.endpoints.services)}
INPUTS = {
    "search": {"query": "latest public developments in battery storage"},
    "read": {"url": "https://example.com/public-source"},
    "verify": {"claim": "The James Webb Space Telescope launched in December 2021."},
}

async def main():
    async with httpx.AsyncClient(timeout=30) as http:
        metadata = (await http.get(METADATA_URL)).json()
        desired_service = os.getenv("AGENT402_SERVICE", "search").lower()
        target = next(
            (item for item in metadata["services"] if item["service"] == desired_service),
            None,
        )
        if target is None or desired_service not in INPUTS:
            raise ValueError(f"Unknown Agent402 service: {desired_service}")

        headers = {
            "Content-Type": "application/json",
            "X-Agent402-Client": "quickstart-python",
        }
        quote = await http.request(
            target["method"], target["url"], json=INPUTS[desired_service], headers=headers
        )
        if quote.status_code != 402:
            raise RuntimeError(f"Expected HTTP 402, got {quote.status_code}")

        payment_url = metadata["endpoints"]["test_payment"]
        if not payment_url:
            raise RuntimeError("Test payment endpoint unavailable")
        payment = await http.post(
            payment_url, json={"transaction_id": quote.json()["transaction_id"]}
        )
        payment.raise_for_status()
        headers[metadata["payment"]["payment_header"]] = payment.json()["x_payment_header"]

        response = await http.request(
            target["method"], target["url"], json=INPUTS[desired_service], headers=headers
        )
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))

if __name__ == "__main__":
    asyncio.run(main())`;
  return `<pre id="quickstart-python" data-testid="quickstart-python"><code>${escapeHtml(source)}</code></pre>`;
}

function searchDemo(
  service: CanonicalServiceMetadata,
  metadata: CanonicalServicesMetadata,
): string {
  const input = JSON.stringify(exampleRequest(service));
  const demoMode = metadata.payment.mode === "test";
  const paymentStep = demoMode
    ? `<article><span>04 / DEMO PAY + RETRY</span><strong>Issue a labeled local test payment</strong><code>same method + endpoint + body</code></article>`
    : `<article><span>04 / AUTHORIZE + RETRY</span><strong>x402 client signs the supplied requirement</strong><code>same method + endpoint + body</code></article>`;
  return `<section id="onboarding-search-demo" class="onboarding-demo" data-testid="onboarding-search-demo">
    <div class="panel-label">End-to-end / live metadata, no payment executed here</div>
    <h2>SEARCH: discovery to structured result</h2>
    <div class="onboarding-flow">
      <article><span>01 / DISCOVER</span><strong>GET service metadata</strong><code>${escapeHtml(metadata.endpoints.services)}</code></article>
      <article><span>02 / REQUEST</span><strong>${escapeHtml(service.method)} ${escapeHtml(shortUrl(service.url))}</strong><code>${escapeHtml(input)}</code></article>
      <article><span>03 / HTTP 402</span><strong>${escapeHtml(formatPrice(service.price_usd))} ${escapeHtml(metadata.payment.asset)}</strong><code>${escapeHtml(metadata.payment.network)} · exact requirement in PAYMENT-REQUIRED</code></article>
      ${paymentStep}
      <article><span>05 / STRUCTURED RESULT</span><strong>${escapeHtml(service.output_fields[0] ?? "result")}</strong><code>${escapeHtml(service.output_fields.slice(1).join(" · "))}</code></article>
    </div>
  </section>`;
}

function docsPage(options: WebsitePageOptions, metadata: CanonicalServicesMetadata, quickstart: boolean): string {
  const defaultService = serviceByName(metadata, "search") ?? metadata.services[0];
  const realX402 = metadata.payment.mode === "testnet";
  const onboarding = defaultService
    ? `<h2>Production onboarding</h2><p>Start with one canonical discovery URL. The programs below select a named service from that response, preserve the exact request through the payment retry, and print structured output.</p>
       ${searchDemo(defaultService, metadata)}
       <h3>TypeScript / Node</h3><p>${
         realX402
           ? `Install the official client dependencies: <code>npm install @x402/fetch @x402/core @x402/evm viem</code>. Set <code>PAYER_PRIVATE_KEY</code> only in your runtime environment; never send it to Agent402.`
           : `Demo-only flow: this uses a clearly labeled local test payment with no wallet, network, or real funds.`
       }</p>
       ${realX402 ? typeScriptQuickstart(metadata) : demoTypeScriptQuickstart(metadata)}
       <h3>Python / httpx</h3><p>${
         realX402
           ? `Use the official x402 Python client wrapper. It handles the HTTP 402 authorization and identical request retry for you.`
           : `Demo-only flow: it receives the mock HTTP 402, mints a local test payment, and retries the unchanged request.`
       }</p>
       ${realX402 ? pythonQuickstart(metadata) : demoPythonQuickstart(metadata)}
       <h3>Privacy-preserving usage attribution</h3><div class="notice"><strong>Optional and coarse by design.</strong> The examples send one of two fixed integration categories in <code>X-Agent402-Client</code>. Attribution analytics only aggregate that category with the public payment surface and service; they do not retain IP addresses, user agents, cookies, browser fingerprints, or identities.</div>`
    : `<div class="empty-state">Unavailable</div>`;
  const docsIntro = defaultService
    ? `<h2>Quickstart</h2><p>Follow the production-ready discovery, 402, payment, and structured-result path in the Quickstart. It contains copy/paste TypeScript and Python clients driven by live metadata.</p><div class="hero-actions" style="margin-top:24px"><a class="button primary" data-testid="link-start-quickstart" href="${options.basePath}/docs/quickstart">Start the Quickstart →</a></div>`
    : `<div class="empty-state">Unavailable</div>`;
  return `${pageHeader(
    quickstart ? "Quickstart" : "Developer documentation",
    quickstart ? "From discovery to structured result." : "Build against the live contract.",
    "Inspect canonical metadata, receive HTTP 402, authorize the exact payment requirement, and consume structured output.",
  )}
  <section class="section"><div class="wrap docs-wrap" style="padding-top:0">
     <h2>Canonical sources</h2><table class="data-table stacked-mobile-table"><thead><tr><th scope="col">Source</th><th scope="col">Use</th></tr></thead><tbody>
       <tr><td data-label="Source"><a href="${options.basePath}/api/v1/services">Service metadata</a></td><td data-label="Use">Service names, endpoints, current price, input contract, output fields, and payment metadata.</td></tr>
       <tr><td data-label="Source"><a href="${options.basePath}/openapi.json">OpenAPI</a></td><td data-label="Use">Full request/response schemas and documented HTTP behavior.</td></tr>
       <tr><td data-label="Source"><a href="${options.basePath}/api/v1/pricing">Pricing</a></td><td data-label="Use">Current per-request prices.</td></tr>
       <tr><td data-label="Source"><a href="${options.basePath}/api/v1/health">Health</a></td><td data-label="Use">Current service runtime state.</td></tr>
    </tbody></table>
     ${quickstart ? onboarding : docsIntro}
    <h2>Available services</h2>${metadata.services
      .map(
        (service) =>
          `<h3>${escapeHtml(service.service.toUpperCase())}</h3><p>${escapeHtml(
            service.method,
          )} <code>${escapeHtml(service.url)}</code></p>${serviceSchema(service)}`,
      )
      .join("")}
    <h2>Payment flow</h2><ol><li>Read service metadata and choose a resource.</li><li>Send the canonical request body without the configured payment signature header.</li><li>Use the HTTP 402 response to obtain the exact current payment requirement.</li><li>Authorize the requirement with an x402-compatible client and retry the identical request.</li></ol>
  </div></section>`;
}

export function websitePageHtml(options: WebsitePageOptions): string {
  const metadata = servicesMetadata(options.config, options.baseUrl);
  const service = serviceByName(metadata, options.service);
  let title = "402Agent.ai — Intelligence for agents";
  let description =
    "Machine-native intelligence services that agents can discover, pay for through x402, and consume as structured results.";
  let content: string;

  if (options.page === "home") {
    content = homePage(options, metadata);
  } else if (options.page === "services") {
    title = "Services — 402Agent.ai";
    content = servicesPage(options, metadata);
  } else if (options.page === "service" && service) {
    title = `${service.service.toUpperCase()} — 402Agent.ai`;
    content = servicePage(options, metadata, service);
  } else if (options.page === "payments") {
    title = "x402 Payments — 402Agent.ai";
    content = paymentsPage(options, metadata);
  } else if (options.page === "bazaar") {
    title = "Coinbase Bazaar — 402Agent.ai";
    content = bazaarPage(options, metadata);
  } else if (options.page === "status") {
    title = "Status — 402Agent.ai";
    content = statusPage(options, metadata);
  } else if (options.page === "quickstart") {
    title = "Quickstart — 402Agent.ai";
    content = docsPage(options, metadata, true);
  } else {
    title = "Developer Documentation — 402Agent.ai";
    content = docsPage(options, metadata, false);
  }

  return pageShell(options, title, description, content);
}