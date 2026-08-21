/**
 * Real x402 payment processor (PAYMENT_MODE=testnet).
 *
 * Implements the CURRENT official x402 v2 seller flow using the official
 * packages (@x402/core, @x402/evm, @x402/extensions):
 *
 *  - 402 response: `PaymentRequired` JSON body + base64 `PAYMENT-REQUIRED`
 *    header, built by x402ResourceServer with the `exact` EVM scheme.
 *  - Payment: client retries with a base64 `PAYMENT-SIGNATURE` header
 *    carrying a signed `PaymentPayload` (EIP-3009 USDC authorization).
 *  - Verification/settlement: delegated to an x402 facilitator
 *    (default https://x402.org/facilitator — Base Sepolia testnet).
 *  - Flow model: `authorization` — verify → do work → settle. Funds only
 *    move after fulfillment succeeds.
 *
 * One network only (Base Sepolia, eip155:84532) with testnet USDC, per spec.
 * Divergence from the original build prompt's assumptions, per current docs:
 * headers are PAYMENT-REQUIRED / PAYMENT-SIGNATURE (not X-PAYMENT), networks
 * are CAIP-2 ids (eip155:84532, not "base-sepolia"), and amounts are atomic
 * token units.
 */

import { createHash } from "node:crypto";
import {
  x402ResourceServer,
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements as X402PaymentRequirements,
} from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { Agent402Config } from "../../config";
import type {
  ServiceName,
  TransactionRecord,
  TransactionStore,
} from "../../database/types";
import { logger } from "../../utils/logger";
import { PaymentError } from "./mock";
import type {
  PaymentProcessor,
  PreparedRequirements,
  SettlementInfo,
  VerifiedPaymentInfo,
} from "./processor";

type PaymentDiagnosticPayload = {
  x402Version: number;
  payloadHash: string;
  authorization: {
    from?: string;
    to?: string;
    value?: string;
    validAfter?: string;
    validBefore?: string;
    nonce?: string;
  };
};

/**
 * Safe, opt-in data for diagnosing facilitator settlement failures.
 * Never log the signed payload or its signature: the SHA-256 hash is enough
 * to correlate a request across verify and settle.
 */
function paymentDiagnosticPayload(
  payload: PaymentPayload,
): PaymentDiagnosticPayload {
  const rawPayload = payload.payload as {
    authorization?: PaymentDiagnosticPayload["authorization"];
  };
  const authorization = rawPayload.authorization ?? {};

  return {
    x402Version: payload.x402Version,
    payloadHash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  };
}

function paymentDiagnosticsEnabled(): boolean {
  return process.env["X402_PAYMENT_DIAGNOSTICS"] === "1";
}

/** Service metadata used for x402 Bazaar discovery declarations. */
const SERVICE_DISCOVERY: Record<
  ServiceName,
  {
    description: string;
    input: Record<string, unknown>;
    inputSchema: Record<string, unknown>;
    output: { example: unknown; schema: Record<string, unknown> };
  }
> = {
  search: {
    description:
      "Search the web and return current, ranked, source-tiered results for a query. " +
      "Useful for: finding recent news, looking up facts, researching topics, discovering sources. " +
      "Returns: array of results (title, url, snippet, source_tier), source list, timestamp. " +
      "Input: { query: string } — the search query (1–2000 characters). " +
      "Output MIME type: application/json. " +
      "Payment: x402 exact USDC on Base Sepolia (eip155:84532).",
    input: { query: "latest NVIDIA earnings announcement" },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to execute (1–2000 characters).",
          minLength: 1,
          maxLength: 2000,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          transaction_id: { type: "string" },
          replayed: { type: "boolean" },
          result: {
            type: "object",
            properties: {
              service: { type: "string", enum: ["search"] },
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    url: { type: "string" },
                    snippet: { type: "string" },
                    source_tier: { type: "integer" },
                  },
                },
              },
              sources: { type: "array", items: { type: "string" } },
              generated_at: { type: "string", format: "date-time" },
            },
          },
        },
      },
      example: {
        transaction_id: "tx_…",
        replayed: false,
        result: {
          service: "search",
          results: [{ title: "NVIDIA Q1 2025 Earnings", url: "https://investor.nvidia.com/…", snippet: "NVIDIA reported record revenue…", source_tier: 1 }],
          sources: ["https://investor.nvidia.com/…"],
          generated_at: "2025-01-01T00:00:00.000Z",
        },
      },
    },
  },
  read: {
    description:
      "Fetch and extract structured content from a public URL. " +
      "Useful for: reading articles, summarizing web pages, extracting facts from a source, understanding what a URL contains. " +
      "Returns: title, summary, key_points[], extracted_facts[] (stated facts only, inference kept separate), source_url. " +
      "Input: { url: string } — a public http/https URL (private network addresses are blocked). " +
      "Output MIME type: application/json. " +
      "Payment: x402 exact USDC on Base Sepolia (eip155:84532).",
    input: { url: "https://example.com/article" },
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          format: "uri",
          description: "A public http/https URL to fetch and extract. Private network addresses (RFC 1918, loopback) are blocked.",
          maxLength: 4000,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          transaction_id: { type: "string" },
          replayed: { type: "boolean" },
          result: {
            type: "object",
            properties: {
              service: { type: "string", enum: ["read"] },
              title: { type: "string" },
              summary: { type: "string" },
              key_points: { type: "array", items: { type: "string" } },
              extracted_facts: { type: "array", items: { type: "string" } },
              source_url: { type: "string", format: "uri" },
            },
          },
        },
      },
      example: {
        transaction_id: "tx_…",
        replayed: false,
        result: {
          service: "read",
          title: "Example Article",
          summary: "A brief summary of the article content…",
          key_points: ["Key point 1", "Key point 2"],
          extracted_facts: ["Stated fact 1", "Stated fact 2"],
          source_url: "https://example.com/article",
        },
      },
    },
  },
  verify: {
    description:
      "Fact-check a claim with evidence-weighted verdicts. " +
      "Useful for: verifying news, checking whether a statement is accurate, finding supporting or contradicting evidence, grounding AI outputs. " +
      "Returns: verdict (VERIFIED | NOT_VERIFIED | INSUFFICIENT_EVIDENCE | CONFLICTING_EVIDENCE), " +
      "confidence score (0–1), supporting_evidence[], contradictory_evidence[], sources[]. " +
      "Honest verdicts: returns INSUFFICIENT_EVIDENCE or CONFLICTING_EVIDENCE when warranted rather than forcing a binary answer. " +
      "Input: { claim: string } — the claim to fact-check (1–4000 characters). " +
      "Output MIME type: application/json. " +
      "Payment: x402 exact USDC on Base Sepolia (eip155:84532).",
    input: { claim: "The James Webb Space Telescope launched in December 2021" },
    inputSchema: {
      type: "object",
      properties: {
        claim: {
          type: "string",
          description: "The claim or statement to fact-check (1–4000 characters).",
          minLength: 1,
          maxLength: 4000,
        },
      },
      required: ["claim"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          transaction_id: { type: "string" },
          replayed: { type: "boolean" },
          result: {
            type: "object",
            properties: {
              service: { type: "string", enum: ["verify"] },
              claim: { type: "string" },
              verdict: { type: "string", enum: ["VERIFIED", "NOT_VERIFIED", "INSUFFICIENT_EVIDENCE", "CONFLICTING_EVIDENCE"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              summary: { type: "string" },
              supporting_evidence: { type: "array", items: { type: "object" } },
              contradictory_evidence: { type: "array", items: { type: "object" } },
              source_count: { type: "integer" },
              primary_source_found: { type: "boolean" },
              generated_at: { type: "string", format: "date-time" },
            },
          },
        },
      },
      example: {
        transaction_id: "tx_…",
        replayed: false,
        result: {
          service: "verify",
          claim: "The James Webb Space Telescope launched in December 2021",
          verdict: "VERIFIED",
          confidence: 0.91,
          summary: "3 supporting evidence items across 3 independent sources, including a primary (tier A) source.",
          supporting_evidence: [{ tier: "A", quote: "JWST lifted off on December 25, 2021 at 7:20 AM ET on an Ariane 5 rocket.", stance: "supports", source_url: "https://science.nasa.gov/mission/webb/launch/" }],
          contradictory_evidence: [],
          source_count: 3,
          primary_source_found: true,
          generated_at: "2025-01-01T00:00:00.000Z",
        },
      },
    },
  },
};

export interface RealX402ProcessorOptions {
  /** Public service name embedded in x402 resource/Bazaar metadata. */
  serviceBrand?: string;
  /** Primary discovery tag embedded in x402 resource metadata. */
  serviceTag?: string;
  /**
   * Build the known Base Sepolia requirements locally instead of querying the
   * facilitator's /supported endpoint before an unpaid quote.
   */
  configuredRequirements?: boolean;
  /**
   * Optional facilitator-specific cap for the public resource description.
   * CDP's x402 v2 verifier currently accepts at most 500 characters.
   */
  maxResourceDescriptionLength?: number;
}

export class RealX402Processor implements PaymentProcessor {
  readonly mode = "testnet" as const;
  readonly paymentHeaderName = "PAYMENT-SIGNATURE";

  private readonly server: x402ResourceServer;
  private readonly network: Network;
  private initialized: Promise<void> | null = null;
  private readonly options: RealX402ProcessorOptions;

  constructor(
    private readonly config: Agent402Config,
    facilitatorClient?: FacilitatorClient,
    options: RealX402ProcessorOptions = {},
  ) {
    this.options = options;
    this.network = config.paymentNetwork as Network;
    const client =
      facilitatorClient ??
      new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    this.server = new x402ResourceServer(client).register(
      this.network,
      new ExactEvmScheme(),
    );
  }

  /** Fetch facilitator-supported kinds once, lazily. */
  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.server.initialize().catch((err) => {
        this.initialized = null; // allow retry on transient failure
        throw err;
      });
    }
    return this.initialized;
  }

  private async requirementsFor(
    tx: TransactionRecord,
  ): Promise<X402PaymentRequirements> {
    if (this.options.configuredRequirements) {
      const asset = getDefaultAsset(this.network);
      const amount = decimalToAtomic(tx.quotedPrice, asset.decimals);
      return {
        scheme: "exact",
        network: this.network,
        amount,
        asset:
          this.config.paymentAsset === "USDC"
            ? asset.address
            : this.config.paymentAsset,
        payTo: this.config.recipientAddress,
        maxTimeoutSeconds: 300,
        extra: {
          name: asset.name,
          version: asset.version,
        },
      };
    }
    await this.ensureInitialized();
    const requirements = await this.server.buildPaymentRequirements({
      scheme: "exact",
      payTo: this.config.recipientAddress,
      // Plain decimal string; the EVM scheme converts to atomic USDC units.
      price: `$${tx.quotedPrice.toFixed(6)}`,
      network: this.network,
    });
    const first = requirements[0];
    if (!first) {
      throw new PaymentError(
        "Unable to build x402 payment requirements",
        "PAYMENT_FAILED",
      );
    }
    return first;
  }

  async buildRequirements(
    tx: TransactionRecord,
    resourceUrl: string,
  ): Promise<PreparedRequirements> {
    const requirements = await this.requirementsFor(tx);
    const meta = SERVICE_DISCOVERY[tx.service];
    const serviceBrand = this.options.serviceBrand ?? "Agent402";
    const serviceTag = this.options.serviceTag ?? "agent402";
    const description = truncateDescription(
      meta.description,
      this.options.maxResourceDescriptionLength,
    );
    const paymentRequired = await this.server.createPaymentRequiredResponse(
      [requirements],
      {
        url: resourceUrl,
        description,
        mimeType: "application/json",
        serviceName: `${serviceBrand} ${tx.service.toUpperCase()}`,
        tags: [serviceTag, tx.service, "intelligence", "ai-agents"],
      },
      "Payment required",
      {
        ...declareDiscoveryExtension({
          // @x402/extensions 2.22.0's runtime schema requires method even
          // though DeclareDiscoveryExtensionInput incorrectly omits it.
          method: "POST",
          bodyType: "json",
          input: meta.input,
          inputSchema: meta.inputSchema,
          output: meta.output,
        } as unknown as Parameters<typeof declareDiscoveryExtension>[0]),
      },
    );
    return {
      body: {
        ...(paymentRequired as unknown as Record<string, unknown>),
        transaction_id: tx.id,
      },
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
      },
    };
  }

  private decode(header: string): PaymentPayload {
    try {
      return decodePaymentSignatureHeader(header);
    } catch {
      throw new PaymentError(
        "Malformed PAYMENT-SIGNATURE header",
        "PAYMENT_NOT_VERIFIED",
      );
    }
  }

  async locateTransaction(
    _header: string,
    service: ServiceName,
    requestHash: string,
    store: TransactionStore,
  ): Promise<TransactionRecord | null> {
    // x402 payloads carry no transaction id; the payment is bound to the
    // exact service + request body that was quoted.
    return store.findPendingByRequestHash(service, requestHash);
  }

  async verify(
    header: string,
    tx: TransactionRecord,
  ): Promise<VerifiedPaymentInfo> {
    const payload = this.decode(header);
    const requirements = await this.requirementsFor(tx);

    // The client must have accepted OUR requirements: scheme, network,
    // asset, recipient, and an amount covering the quoted price.
    const accepted = payload.accepted;
    if (
      accepted.scheme !== requirements.scheme ||
      accepted.network !== requirements.network ||
      accepted.asset.toLowerCase() !== requirements.asset.toLowerCase() ||
      accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase()
    ) {
      throw new PaymentError(
        "Payment does not match this service's payment requirements",
        "PAYMENT_NOT_VERIFIED",
      );
    }
    let amountOk = false;
    try {
      amountOk = BigInt(accepted.amount) >= BigInt(requirements.amount);
    } catch {
      amountOk = false;
    }
    if (!amountOk) {
      throw new PaymentError(
        "Payment amount is less than the quoted price",
        "PAYMENT_NOT_VERIFIED",
      );
    }

    const verifyStartedMs = Date.now();
    const verifyStartedAt = new Date().toISOString();
    const result = await this.server.verifyPayment(payload, requirements);
    if (paymentDiagnosticsEnabled()) {
      logger.info(
        {
          phase: "verify",
          facilitatorEndpoint: `${this.config.facilitatorUrl}/verify`,
          startedAt: verifyStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - verifyStartedMs,
          transaction_id: tx.id,
          payment: paymentDiagnosticPayload(payload),
          paymentRequirements: requirements,
          facilitatorResponse: result,
        },
        "x402 facilitator verify response",
      );
    }
    if (!result.isValid) {
      logger.warn(
        { invalid_reason: result.invalidReason, transaction_id: tx.id },
        "x402 payment verification failed",
      );
      throw new PaymentError(
        `Payment not verified${result.invalidReason ? `: ${result.invalidReason}` : ""}`,
        "PAYMENT_NOT_VERIFIED",
      );
    }

    return {
      reference: paymentReference(header),
      authorizationNonce: extractAuthorizationNonce(payload),
      payer: result.payer ?? null,
      paymentStatus: "verified_x402",
      settle: async (): Promise<SettlementInfo> => {
        const settleStartedMs = Date.now();
        const settleStartedAt = new Date().toISOString();
        const settle = await this.server.settlePayment(payload, requirements);
        if (paymentDiagnosticsEnabled()) {
          logger.info(
            {
              phase: "settle",
              facilitatorEndpoint: `${this.config.facilitatorUrl}/settle`,
              startedAt: settleStartedAt,
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - settleStartedMs,
              transaction_id: tx.id,
              payment: paymentDiagnosticPayload(payload),
              paymentRequirements: requirements,
              settlementTransactionHash: settle.transaction ?? null,
              facilitatorResponse: settle,
            },
            "x402 facilitator settle response",
          );
        }
        if (!settle.success) {
          throw new PaymentError(
            `Settlement failed${settle.errorReason ? `: ${settle.errorReason}` : ""}`,
            "PAYMENT_FAILED",
          );
        }
        return {
          transactionHash: settle.transaction || null,
          network: settle.network,
          payer: settle.payer ?? null,
        };
      },
    };
  }

  extractHeader(
    get: (name: string) => string | undefined,
  ): string | undefined {
    return get("PAYMENT-SIGNATURE");
  }

  referenceFor(header: string): string | null {
    return paymentReference(header);
  }
}

function decimalToAtomic(price: number, decimals: number): string {
  const [whole = "0", fraction = ""] = price.toFixed(decimals).split(".");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"))
  ).toString();
}

function truncateDescription(
  description: string,
  maxLength: number | undefined,
): string {
  if (!maxLength || description.length <= maxLength) return description;
  return `${description.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Unique payment reference for duplicate-payment protection: sha256 of the
 * signed PAYMENT-SIGNATURE header bytes.
 *
 * Hashing the entire header (including the outer signature) means replaying
 * the same exact bytes always resolves to the same reference, while any
 * re-signed variant (even with the same EIP-3009 nonce) produces a different
 * hash. This keeps the pre-verification replay path in flow.ts safe — a
 * caller must present the exact original signed bytes to recover a cached
 * result, providing proof-of-knowledge of the signature without re-running
 * the facilitator.
 *
 * Duplicate-settlement protection for re-signed same-nonce payments is
 * handled by the separate `authorizationNonce` idempotency key, which is
 * extracted from the verified payload after the facilitator approves the
 * signature and stored with a UNIQUE constraint.
 */
export function paymentReference(header: string): string {
  return `x402-${createHash("sha256").update(header).digest("hex")}`;
}

/**
 * Build the EIP-3009 authorization key from a verified PaymentPayload.
 *
 * ## Why not the x402 Payment-Identifier?
 * x402 v2 (`PaymentPayload`) carries no built-in payment identifier field —
 * `payload.payload` is `Record<string, unknown>` and the spec defines no
 * mandatory ID at that level. When a Payment-Identifier mechanism is added to
 * a future x402 version, it should replace this function as the primary key.
 *
 * ## EIP-3009 nonce scope
 * On-chain, USDC's `authorizationState` is keyed by `(address authorizer,
 * bytes32 nonce)` — i.e. uniqueness is per authorizer address, not per nonce
 * value alone.  Two different payers can legitimately use the same 32-byte
 * nonce without conflict; a key built from the nonce alone would incorrectly
 * block the second payer's independent payment.
 *
 * The composite key `{network}:{from}:{nonce}` mirrors the on-chain guarantee
 * exactly:
 *  - `network`  — scopes to a specific chain + USDC contract instance
 *                 (e.g. `eip155:84532` for Base Sepolia)
 *  - `from`     — the EIP-3009 authorizer address (payer wallet)
 *  - `nonce`    — the 32-byte single-use nonce consumed by the USDC contract
 *
 * Together they uniquely identify one authorization intent. A client that
 * re-signs the same intent with a fresh outer signature keeps the same key,
 * so `claimForProcessing` rejects the duplicate at the DB level via the
 * UNIQUE constraint on `authorization_nonce` before settlement can occur.
 *
 * `to`, `value`, and `validBefore` are intentionally excluded: the on-chain
 * uniqueness guarantee does not include them, and adding them would make the
 * key overly narrow (a typo in `value` would produce a different key for the
 * same nonce, bypassing the guard).
 *
 * The payload type uses `Record<string, unknown>` for the scheme-specific
 * inner object, so all fields are narrowed manually before use.
 */
export function extractAuthorizationNonce(
  payload: PaymentPayload,
): string | null {
  const auth = payload.payload["authorization"];
  if (auth === null || typeof auth !== "object") return null;
  const a = auth as Record<string, unknown>;
  const from =
    typeof a["from"] === "string" ? a["from"].toLowerCase() : null;
  const nonce =
    typeof a["nonce"] === "string" ? a["nonce"].toLowerCase() : null;
  const network = payload.accepted.network ?? null;
  if (!from || !nonce || !network) return null;
  return `${network}:${from}:${nonce}`;
}
