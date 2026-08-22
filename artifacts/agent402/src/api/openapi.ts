/**
 * OpenAPI 3.1 spec for Agent402 — generated dynamically so pricing is
 * always current. Served at GET /agent402/openapi.json.
 *
 * Design goals:
 * - An AI agent given only the base URL can GET /agent402/openapi.json and
 *   know every service, its price, the x402 payment flow, and the exact
 *   request/response shape.
 * - No secrets or private information appear here. Recipient address is
 *   not embedded; it arrives in the live 402 PAYMENT-REQUIRED header.
 */

import type { Agent402Config } from "../config";
import { buildQuote } from "../pricing/engine";

function paymentRequiredSchema(network: string): object {
  return {
    type: "object",
    description:
      "x402 payment requirement. Also base64-encoded in the PAYMENT-REQUIRED response header. " +
      "Pass the decoded object to @x402/fetch or build a PAYMENT-SIGNATURE manually.",
    properties: {
      transaction_id: {
        type: "string",
        description:
          "Opaque per-quote ID. The payment is bound to the exact service + request body that generated it. " +
          "Retrying with a different body requires a new quote.",
        example: "tx_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      },
      x402Version: { type: "integer", enum: [2] },
      resource: {
        type: "string",
        description: "Canonical URL of the paid resource.",
      },
      accepts: {
        type: "array",
        description: "Ordered list of accepted payment schemes. Use the first matching one.",
        items: {
          type: "object",
          properties: {
            scheme: { type: "string", enum: ["exact"] },
            network: {
              type: "string",
              description: "CAIP-2 network identifier.",
               example: network,
            },
            payTo: {
              type: "string",
              description: "Recipient wallet address (checksummed EVM hex).",
            },
            asset: {
              type: "string",
              description: "USDC contract address on the payment network.",
            },
            amount: {
              type: "string",
              description:
                "Exact payment amount in atomic USDC units (6 decimal places). " +
                "Divide by 1,000,000 for the USD value.",
              example: "282000",
            },
          },
          required: ["scheme", "network", "payTo", "asset", "amount"],
        },
      },
    },
    required: ["transaction_id", "x402Version", "accepts"],
  };
}

function settlementSchema(network: string): object {
  return {
    type: "object",
    description: "On-chain settlement details. Present only when replayed is false.",
    properties: {
      transactionHash: {
        type: "string",
        description: "Settlement transaction hash on the payment network.",
        example: "0x4fba7298581e89e4b5dc8d5fde65ca9df4600a6ddbbc2f7dd41da73ef9d5654d",
      },
      network: {
        type: "string",
        description: "CAIP-2 network where settlement occurred.",
         example: network,
      },
    },
    required: ["transactionHash", "network"],
  };
}

function successEnvelope(resultRef: string, network: string): object {
  return {
    type: "object",
    properties: {
      transaction_id: { type: "string" },
      replayed: {
        type: "boolean",
        description:
          "True when this payment was already consumed and the cached result is returned. " +
          "No additional charge; settlement is not included.",
      },
      settlement: { ...settlementSchema(network), nullable: true },
      result: { $ref: resultRef },
    },
    required: ["transaction_id", "replayed", "result"],
  };
}

function paymentRequiredResponse(): object {
  return {
    description:
      "Payment required (x402). Decode the PAYMENT-REQUIRED header or parse the JSON body " +
      "to get exact payment requirements, then retry with PAYMENT-SIGNATURE.",
    headers: {
      "PAYMENT-REQUIRED": {
        description:
          "Base64-encoded x402 PaymentRequired object. " +
          "Use @x402/core/http decodePaymentRequiredHeader() to decode.",
        schema: { type: "string" },
        required: true,
      },
    },
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/PaymentRequired" },
      },
    },
  };
}

function errorResponses(): Record<string, object> {
  return {
    "400": {
      description: "Invalid request body.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
    },
    "429": {
      description: "Rate limited.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
    },
    "500": {
      description: "Internal error or cost budget exceeded.",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
    },
    "503": {
      description: "Request cannot be served profitably right now (UNPROFITABLE_REQUEST).",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
    },
  };
}

export function openApiSpec(config: Agent402Config, origin: string): object {
  const basePath = "/agent402";
  // Use the configured canonical public URL when available so external agents
  // see the real production address rather than a dev-only derived origin.
  const baseUrl = config.publicUrl ?? `${origin}${basePath}`;

  const searchPrice = buildQuote(config, "search").price;
  const readPrice = buildQuote(config, "read").price;
  const verifyPrice = buildQuote(config, "verify").price;

  const networkLabel =
    config.paymentMode === "production"
      ? "Base mainnet (eip155:8453) — real USDC payments"
      : config.paymentMode === "testnet"
        ? "Base Sepolia testnet (eip155:84532) — no real money"
        : "demo mode — simulated payments";

  return {
    openapi: "3.1.0",
    info: {
      title: "Agent402",
      version: "0.1.0",
      summary: "High-accuracy intelligence for AI agents. Pay per request via x402 (HTTP 402 + USDC).",
      description: `
Agent402 sells three intelligence services to AI agents, charged per request via the
**x402 protocol** — HTTP 402 with USDC on ${config.paymentNetwork}.

No accounts, no API keys, no subscriptions. Your agent pays only for what it uses.

## x402 Payment Flow

1. **Request without payment** — \`POST\` to any paid endpoint. Receive \`402 Payment Required\`
   with exact requirements in both the JSON body and the \`PAYMENT-REQUIRED\` response header
   (base64-encoded x402 \`PaymentRequired\` object). Capture the \`transaction_id\`.

2. **Pay and retry** — Sign a USDC EIP-3009 authorization matching those requirements
   (scheme \`exact\`, network \`${config.paymentNetwork}\`, exact amount, exact payTo).
   Retry the **identical** request body with your signed payload base64-encoded in the
   \`PAYMENT-SIGNATURE\` header. The \`@x402/fetch\` npm package handles this automatically.

3. **Receive result** — The facilitator verifies the payment, the service runs under a hard
   cost budget, and settlement happens on-chain only after work succeeds. The response
   includes your result plus a settlement transaction hash.

## Key Constraints

- A payment is bound to the exact service + request body that generated the quote.
- Each payment is consumed exactly once. Replaying an identical payment returns the cached
  result (\`replayed: true\`) at no extra charge.
- Work halts if fulfillment would exceed the cost budget; payment is never settled in that case.

## Network

**Mode:** \`${config.paymentMode}\` — ${networkLabel}  
**Asset:** USDC (6 decimal places — amounts in 402 responses are in atomic units)  
**Facilitator:** ${config.facilitatorUrl}

## Client Library (recommended)

\`\`\`bash
npm install @x402/fetch @x402/core @x402/evm viem
\`\`\`

\`\`\`typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import * as evmClient from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY as \`0x\${string}\`);
const client = new x402Client();
evmClient.registerExactEvmScheme(client, { signer });
const fetchWithPay = wrapFetchWithPayment(fetch, client);

// Call any paid endpoint — 402 + payment handled automatically:
const res = await fetchWithPay("${baseUrl}/api/v1/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ claim: "..." }),
});
console.log(await res.json());
\`\`\`
`.trim(),
      contact: {
        name: "Agent402",
        url: baseUrl,
      },
      "x-payment-protocol": {
        protocol: "x402",
        x402_version: 2,
        scheme: "exact",
        network: config.paymentNetwork,
        asset: config.paymentAsset,
        mode: config.paymentMode,
        facilitator: config.facilitatorUrl,
        request_header: "PAYMENT-REQUIRED",
        signature_header: "PAYMENT-SIGNATURE",
        client_library: "npm:@x402/fetch",
        note:
          config.paymentMode === "production"
            ? "Production mode — uses Base mainnet USDC."
            : config.paymentMode === "testnet"
              ? "Testnet mode — uses Base Sepolia USDC, no real money."
              : "Demo mode — payments are simulated test tokens.",
      },
    },
    servers: [
      {
        url: baseUrl,
        description: `Agent402 (${config.paymentMode} — ${config.paymentNetwork})`,
      },
    ],
    paths: {
      "/api/v1/health": {
        get: {
          operationId: "getHealth",
          tags: ["Discovery"],
          summary: "Service health and payment mode",
          description: "Returns service status, version, and current payment mode. No payment required.",
          responses: {
            "200": {
              description: "Service is healthy",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/HealthResponse" },
                  example: {
                    status: "ok",
                    service: "agent402",
                    version: "0.1.0",
                    payment_mode: config.paymentMode,
                    time: new Date().toISOString(),
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/pricing": {
        get: {
          operationId: "getPricing",
          tags: ["Discovery"],
          summary: "Live per-request prices",
          description:
            "Returns current prices for all services in USD. " +
            "Actual amounts in 402 Payment Required responses are in atomic USDC units (multiply USD × 1,000,000). " +
            "Prices may vary slightly based on real-time cost estimates.",
          responses: {
            "200": {
              description: "Current pricing for all services",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PricingResponse" },
                  example: {
                    pricing: [
                      { service: "search", price_usd: searchPrice, payment_asset: config.paymentAsset, payment_network: config.paymentNetwork, payment_mode: config.paymentMode },
                      { service: "read", price_usd: readPrice, payment_asset: config.paymentAsset, payment_network: config.paymentNetwork, payment_mode: config.paymentMode },
                      { service: "verify", price_usd: verifyPrice, payment_asset: config.paymentAsset, payment_network: config.paymentNetwork, payment_mode: config.paymentMode },
                    ],
                    note: "Prices are quoted per request via HTTP 402 payment requirements.",
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/services": {
        get: {
          operationId: "getServices",
          tags: ["Discovery"],
          summary: "Machine-readable service discovery document",
          description:
            "Complete service metadata including payment protocol, network, all service endpoints, and current pricing. " +
            "The canonical discovery document for agents — parse this first to understand available services and how to pay. " +
            "402 responses from paid endpoints also embed the official x402 Bazaar discovery extension.",
          responses: {
            "200": {
              description: "Service discovery document",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ServicesDiscovery" },
                },
              },
            },
          },
        },
      },
      "/api/v1/search": {
        post: {
          operationId: "search",
          tags: ["Paid Services"],
          summary: "Web search — current, ranked, tiered results",
          description: `Returns current, relevant results for a query — ranked, deduplicated, and tiered by source quality, with publication timestamps where available.

**Price:** ~$${searchPrice.toFixed(3)} per request  
**Payment:** x402 — call without \`PAYMENT-SIGNATURE\` to receive a 402 quote, then retry with payment.`,
          "x-price-usd": searchPrice,
          "x-x402-required": true,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SearchRequest" },
                example: { query: "latest NVIDIA earnings announcement" },
              },
            },
          },
          responses: {
            "200": {
              description: "Search results (payment accepted and settled on-chain)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SearchSuccessResponse" },
                },
              },
            },
            "402": paymentRequiredResponse(),
            ...errorResponses(),
          },
        },
      },
      "/api/v1/read": {
        post: {
          operationId: "read",
          tags: ["Paid Services"],
          summary: "Read and extract structured content from a URL",
          description: `Fetches a public URL and returns structured extraction: title, summary, key points, and stated facts kept separate from inference.

**SSRF protection:** Only public http/https URLs are accepted. Private network ranges (RFC 1918, loopback, link-local) and non-HTTP schemes are rejected.

**Price:** ~$${readPrice.toFixed(3)} per request  
**Payment:** x402 — call without \`PAYMENT-SIGNATURE\` to receive a 402 quote, then retry with payment.`,
          "x-price-usd": readPrice,
          "x-x402-required": true,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReadRequest" },
                example: { url: "https://example.com/article" },
              },
            },
          },
          responses: {
            "200": {
              description: "Extracted content (payment accepted and settled on-chain)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/ReadSuccessResponse" },
                },
              },
            },
            "402": paymentRequiredResponse(),
            ...errorResponses(),
          },
        },
      },
      "/api/v1/verify": {
        post: {
          operationId: "verify",
          tags: ["Paid Services"],
          summary: "Fact-check a claim with evidence-weighted verdicts",
          description: `Returns an evidence-weighed verdict on a claim. Verdicts are honest: \`INSUFFICIENT_EVIDENCE\` and \`CONFLICTING_EVIDENCE\` are returned when the evidence warrants it — the service never forces a verdict when the evidence doesn't support one.

Verdicts:
- \`VERIFIED\` — strong supporting evidence, no significant contradiction
- \`NOT_VERIFIED\` — evidence contradicts the claim
- \`INSUFFICIENT_EVIDENCE\` — not enough reliable sources to decide
- \`CONFLICTING_EVIDENCE\` — credible sources disagree

**Price:** ~$${verifyPrice.toFixed(3)} per request  
**Payment:** x402 — call without \`PAYMENT-SIGNATURE\` to receive a 402 quote, then retry with payment.`,
          "x-price-usd": verifyPrice,
          "x-x402-required": true,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VerifyRequest" },
                example: { claim: "The James Webb Space Telescope launched in December 2021" },
              },
            },
          },
          responses: {
            "200": {
              description: "Verification result (payment accepted and settled on-chain)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/VerifySuccessResponse" },
                },
              },
            },
            "402": paymentRequiredResponse(),
            ...errorResponses(),
          },
        },
      },
    },
    components: {
      schemas: {
        // ── Discovery ────────────────────────────────────────────────────────
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ok"] },
            service: { type: "string" },
            version: { type: "string" },
            payment_mode: { type: "string", enum: ["test", "testnet", "production"] },
            time: { type: "string", format: "date-time" },
          },
          required: ["status", "service", "version", "payment_mode", "time"],
        },
        PricingResponse: {
          type: "object",
          properties: {
            pricing: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  service: { type: "string", enum: ["search", "read", "verify"] },
                  price_usd: { type: "number", description: "Approximate price in USD" },
                  payment_asset: { type: "string" },
                  payment_network: { type: "string" },
                  payment_mode: { type: "string" },
                },
                required: ["service", "price_usd", "payment_asset", "payment_network", "payment_mode"],
              },
            },
            note: { type: "string" },
          },
          required: ["pricing"],
        },
        ServicesDiscovery: {
          type: "object",
          description: "Canonical discovery document. Parse to discover all services, pricing, and payment requirements.",
          properties: {
            name: { type: "string" },
            tagline: { type: "string" },
            payment: {
              type: "object",
              description: "x402 payment protocol configuration",
              properties: {
                protocol: { type: "string", enum: ["x402"] },
                x402_version: { type: "integer", enum: [2] },
                scheme: { type: "string", enum: ["exact"] },
                asset: { type: "string" },
                network: { type: "string" },
                mode: { type: "string" },
                facilitator: { type: "string", nullable: true },
                payment_header: { type: "string" },
                note: { type: "string" },
              },
            },
            services: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  service: { type: "string" },
                  method: { type: "string", enum: ["POST"] },
                  url: { type: "string" },
                  price_usd: { type: "number" },
                  input: { type: "object" },
                  output_fields: { type: "array", items: { type: "string" } },
                },
              },
            },
            endpoints: {
              type: "object",
              properties: {
                health: { type: "string" },
                pricing: { type: "string" },
                docs: { type: "string" },
                openapi: { type: "string" },
              },
            },
          },
        },

        // ── x402 Payment ─────────────────────────────────────────────────────
        PaymentRequired: paymentRequiredSchema(config.paymentNetwork),

        // ── Shared ───────────────────────────────────────────────────────────
        Settlement: settlementSchema(config.paymentNetwork),
        ErrorResponse: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  enum: [
                    "INVALID_REQUEST",
                    "PAYMENT_NOT_VERIFIED",
                    "PAYMENT_FAILED",
                    "NOT_FOUND",
                    "RATE_LIMITED",
                    "BUDGET_EXCEEDED",
                    "UNPROFITABLE_REQUEST",
                    "INTERNAL_ERROR",
                  ],
                },
                message: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
          required: ["error"],
        },

        // ── Search ───────────────────────────────────────────────────────────
        SearchRequest: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: 2000,
              description: "Search query (1–2000 characters)",
            },
          },
          required: ["query"],
        },
        SearchResult: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string", format: "uri" },
            snippet: { type: "string" },
            source_tier: {
              type: "integer",
              description: "Source quality tier (1 = highest quality primary source)",
            },
            published_date: { type: "string", nullable: true },
          },
          required: ["title", "url", "snippet"],
        },
        SearchResult_Result: {
          type: "object",
          properties: {
            service: { type: "string", enum: ["search"] },
            results: { type: "array", items: { $ref: "#/components/schemas/SearchResult" } },
            sources: { type: "array", items: { type: "string" } },
            generated_at: { type: "string", format: "date-time" },
          },
          required: ["service", "results", "sources", "generated_at"],
        },
        SearchSuccessResponse: {
          ...successEnvelope(
            "#/components/schemas/SearchResult_Result",
            config.paymentNetwork,
          ),
          description: "Successful search response with settlement proof",
        },

        // ── Read ─────────────────────────────────────────────────────────────
        ReadRequest: {
          type: "object",
          properties: {
            url: {
              type: "string",
              format: "uri",
              maxLength: 4000,
              description:
                "Public http/https URL to fetch. Private network ranges are blocked (SSRF protection).",
            },
          },
          required: ["url"],
        },
        ReadResult_Result: {
          type: "object",
          properties: {
            service: { type: "string", enum: ["read"] },
            title: { type: "string" },
            summary: { type: "string", description: "High-level summary of the page content" },
            key_points: { type: "array", items: { type: "string" } },
            extracted_facts: {
              type: "array",
              items: { type: "string" },
              description: "Stated facts only — inference is kept separate",
            },
            source_url: { type: "string", format: "uri" },
          },
          required: ["service", "title", "summary", "source_url"],
        },
        ReadSuccessResponse: {
          ...successEnvelope(
            "#/components/schemas/ReadResult_Result",
            config.paymentNetwork,
          ),
          description: "Successful read response with settlement proof",
        },

        // ── Verify ───────────────────────────────────────────────────────────
        VerifyRequest: {
          type: "object",
          properties: {
            claim: {
              type: "string",
              minLength: 1,
              maxLength: 4000,
              description: "The claim to fact-check (1–4000 characters)",
            },
          },
          required: ["claim"],
        },
        EvidenceItem: {
          type: "object",
          properties: {
            tier: { type: "string", description: "Source quality tier (A = primary/authoritative)" },
            quote: { type: "string" },
            stance: { type: "string", enum: ["supports", "contradicts", "neutral"] },
            statement: { type: "string" },
            source_url: { type: "string", format: "uri" },
            published_date: { type: "string", nullable: true },
          },
          required: ["tier", "quote", "stance", "statement", "source_url"],
        },
        VerifyResult_Result: {
          type: "object",
          properties: {
            service: { type: "string", enum: ["verify"] },
            claim: { type: "string" },
            verdict: {
              type: "string",
              enum: ["VERIFIED", "NOT_VERIFIED", "INSUFFICIENT_EVIDENCE", "CONFLICTING_EVIDENCE"],
              description:
                "Evidence-weighted verdict. Honest: INSUFFICIENT_EVIDENCE and CONFLICTING_EVIDENCE " +
                "are returned when the evidence warrants it rather than forcing a binary answer.",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Confidence score (0–1). Reflects source quality, agreement, recency, and coverage.",
            },
            summary: { type: "string" },
            supporting_evidence: {
              type: "array",
              items: { $ref: "#/components/schemas/EvidenceItem" },
            },
            contradictory_evidence: {
              type: "array",
              items: { $ref: "#/components/schemas/EvidenceItem" },
            },
            sources: { type: "array", items: { type: "object" } },
            source_count: { type: "integer" },
            primary_source_found: { type: "boolean" },
            generated_at: { type: "string", format: "date-time" },
          },
          required: ["service", "claim", "verdict", "confidence", "generated_at"],
        },
        VerifySuccessResponse: {
          ...successEnvelope(
            "#/components/schemas/VerifyResult_Result",
            config.paymentNetwork,
          ),
          description: "Successful verification response with settlement proof",
        },
      },
    },
    tags: [
      {
        name: "Discovery",
        description: "Free endpoints — no payment required. Use these to discover services, pricing, and capabilities.",
      },
      {
        name: "Paid Services",
        description:
          "x402-gated endpoints. Call without payment to receive a 402 quote, " +
          "then retry with a PAYMENT-SIGNATURE header containing a signed USDC EIP-3009 authorization.",
      },
    ],
  };
}
