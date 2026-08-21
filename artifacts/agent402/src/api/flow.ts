/**
 * Core request → 402 → payment → verification → fulfillment orchestration.
 * Framework-agnostic so tests can drive it directly. Payment mechanics are
 * behind the PaymentProcessor interface (mock in test mode, real x402 in
 * testnet mode); this flow is identical for both:
 *
 *   quote → 402 → verify payment → atomic claim → hard budget → work
 *   → settle (real x402 only, authorization flow) → record economics.
 */

import type { Agent402Config } from "../config";
import { CostLedger } from "../costs/ledger";
import type {
  RequestSurface,
  ServiceName,
  TransactionStore,
} from "../database/types";
import { PaymentError } from "../payments/x402/mock";
import type {
  PaymentProcessor,
  PreparedRequirements,
} from "../payments/x402/processor";
import { BudgetTracker, BudgetExceededError } from "../pricing/budget";
import { buildQuote, fulfillmentBudgetFor } from "../pricing/engine";
import {
  fulfill,
  defaultStepPlan,
  type FulfillmentStep,
  type FulfillFn,
} from "../services/fulfillment";
import { ApiError } from "../security/errors";
import { hashRequest, newTransactionId } from "../utils/hash";
import { logger } from "../utils/logger";

export interface QuoteOutcome {
  kind: "payment_required";
  transactionId: string;
  requirements: PreparedRequirements;
}

export interface CompletedOutcome {
  kind: "completed";
  transactionId: string;
  result: unknown;
  replayed: boolean;
  settlement?: {
    transactionHash: string | null;
    network: string;
  };
}

export type FlowError =
  | { kind: "error"; code: string; statusCode: number; message: string };

export type PaidRequestOutcome = QuoteOutcome | CompletedOutcome | FlowError;

export type DeferredBodyValidation =
  | { valid: true; data: unknown }
  | { valid: false; message: string };

/**
 * Handle a service request. Without a valid payment header this quotes a
 * price and returns 402 payment requirements; with one it verifies payment,
 * creates the hard fulfillment budget, performs the work, settles the
 * payment (real x402), and records the full economics on the transaction.
 */
export async function handleServiceRequest(opts: {
  config: Agent402Config;
  store: TransactionStore;
  processor: PaymentProcessor;
  service: ServiceName;
  body: unknown;
  paymentHeader?: string | undefined;
  /** Public URL of this resource (used in x402 payment requirements). */
  resourceUrl?: string;
  /** Isolates pending quotes that use different facilitator route surfaces. */
  paymentNamespace?: string;
  /**
   * Coarse, privacy-preserving source for aggregate operator analytics. This
   * is intentionally not part of the payment binding or request hash.
   */
  requestSurface?: RequestSurface;
  /** Optional bounded integration label supplied by the caller. */
  clientLabel?: string;
  /**
   * Optional application-input validation that runs only after an attached
   * payment has been verified. This supports discovery probes that need an
   * unpaid 402 before they can provide a service-specific request body.
   */
  validateBodyAfterPayment?: (body: unknown) => DeferredBodyValidation;
  /**
   * Real fulfiller (SEARCH/READ/VERIFY). When omitted, the safe stub
   * fulfiller runs (tests/demo — no real provider spend).
   */
  fulfiller?: FulfillFn;
  /** Test hook: override the simulated fulfillment step plan. */
  stepPlan?: FulfillmentStep[];
}): Promise<PaidRequestOutcome> {
  const { config, store, processor, service, body, paymentHeader } = opts;
  const resourceUrl =
    opts.resourceUrl ?? `https://agent402.example/api/v1/${service}`;
  const requestHash = hashRequest(
    service,
    opts.paymentNamespace
      ? { payment_namespace: opts.paymentNamespace, body }
      : body,
  );

  // ---- No payment attached: quote and demand payment (402). -------------
  if (!paymentHeader) {
    const quote = buildQuote(config, service);
    const transactionId = newTransactionId();
    const created = await store.create({
      id: transactionId,
      service,
      requestHash,
      quotedPrice: quote.price,
      paymentAsset: config.paymentAsset,
      paymentNetwork: config.paymentNetwork,
      requestSurface: opts.requestSurface ?? "x402",
      clientLabel: opts.clientLabel ?? "unattributed",
      paymentMode: processor.mode,
      estimatedCost: quote.estimatedCost,
      budgetedCost: quote.budgetedCost,
      status: "REQUESTED",
    });
    await store.update(transactionId, { status: "QUOTED" });
    await store.update(transactionId, { status: "PAYMENT_REQUIRED" });
    let requirements: PreparedRequirements;
    try {
      requirements = await processor.buildRequirements(created, resourceUrl);
    } catch (err) {
      logger.error({ err }, "failed to build payment requirements");
      await store.update(transactionId, {
        status: "FAILED",
        errorCode: "PAYMENT_FAILED",
      });
      return {
        kind: "error",
        code: "PAYMENT_FAILED",
        statusCode: 502,
        message: "Unable to prepare payment requirements. Try again shortly.",
      };
    }
    return { kind: "payment_required", transactionId, requirements };
  }

  // ---- Payment attached: verify, budget, fulfill, settle. -----------------
  const startedAt = Date.now();
  const tx = await processor.locateTransaction(
    paymentHeader,
    service,
    requestHash,
    store,
  );
  if (!tx) {
    // A completed transaction paid with this same payment replays its result
    // (idempotent retry) — check before rejecting outright.
    const ref = processor.referenceFor(paymentHeader);
    if (ref) {
      const prior = await store.findByPaymentReference(ref);
      if (
        prior?.status === "COMPLETED" &&
        prior.service === service &&
        prior.requestHash === requestHash
      ) {
        return {
          kind: "completed",
          transactionId: prior.id,
          result: prior.result,
          replayed: true,
        };
      }
    }
    return {
      kind: "error",
      code: "PAYMENT_NOT_VERIFIED",
      statusCode: 402,
      message:
        "No pending quote matches this payment. Request a new quote first.",
    };
  }

  let verified;
  try {
    verified = await processor.verify(paymentHeader, tx);
  } catch (err) {
    if (err instanceof PaymentError) {
      return {
        kind: "error",
        code: err.code,
        statusCode: 402,
        message: err.message,
      };
    }
    throw err;
  }

  // Bind the payment to the exact quoted service + request body: a valid
  // payment cannot be redeemed against a different endpoint or payload.
  if (tx.service !== service || tx.requestHash !== requestHash) {
    return {
      kind: "error",
      code: "PAYMENT_NOT_VERIFIED",
      statusCode: 402,
      message:
        "Payment is bound to a different service or request body. Request a new quote.",
    };
  }

  let validatedBody = body;
  if (opts.validateBodyAfterPayment) {
    const validation = opts.validateBodyAfterPayment(body);
    if (!validation.valid) {
      return {
        kind: "error",
        code: "INVALID_REQUEST",
        statusCode: 400,
        message: validation.message,
      };
    }
    validatedBody = validation.data;
  }

  // Idempotency / duplicate-payment protection: a payment reference is
  // consumed exactly once. Replays of a completed transaction return the
  // cached result without doing (or charging for) any new work.
  if (tx.status === "COMPLETED" && tx.paymentReference === verified.reference) {
    return {
      kind: "completed",
      transactionId: tx.id,
      result: tx.result,
      replayed: true,
    };
  }

  // Atomically claim the transaction (PAYMENT_VERIFIED -> PROCESSING).
  // Exactly one concurrent retry wins; losers replay or get a conflict.
  const claimed = await store.claimForProcessing(tx.id, {
    paymentReference: verified.reference,
    revenue: tx.quotedPrice,
    paymentStatus: verified.paymentStatus,
    payer: verified.payer,
    authorizationNonce: verified.authorizationNonce,
  });
  if (!claimed) {
    const latest = await store.get(tx.id);
    if (
      latest?.status === "COMPLETED" &&
      latest.paymentReference === verified.reference
    ) {
      return {
        kind: "completed",
        transactionId: latest.id,
        result: latest.result,
        replayed: true,
      };
    }
    // The same payment may have completed a DIFFERENT transaction row
    // (e.g. a re-quote of the same request): replay that result too.
    const byRef = await store.findByPaymentReference(verified.reference);
    if (byRef?.status === "COMPLETED") {
      return {
        kind: "completed",
        transactionId: byRef.id,
        result: byRef.result,
        replayed: true,
      };
    }
    return {
      kind: "error",
      code: "PAYMENT_NOT_VERIFIED",
      statusCode: 409,
      message: `Transaction is ${latest?.status ?? "unavailable"}; this payment cannot be applied again.`,
    };
  }

  const budget = new BudgetTracker(fulfillmentBudgetFor(config, tx.quotedPrice));
  const ledger = new CostLedger(tx.id);

  try {
    const rawResult =
      opts.fulfiller && !opts.stepPlan
        ? await opts.fulfiller(service, validatedBody, budget, ledger)
        : await fulfill(
            service,
            budget,
            ledger,
            opts.stepPlan ?? defaultStepPlan(service),
          );
    const result = rawResult as Record<string, unknown>;
    // Persist accuracy telemetry when the service reports it (VERIFY).
    const confidenceScore =
      typeof result["confidence"] === "number" ? result["confidence"] : null;
    const sourceCount =
      typeof result["source_count"] === "number" ? result["source_count"] : null;
    const summary = ledger.summarize(tx.quotedPrice);

    // Settle AFTER the work succeeds (x402 authorization flow). If
    // settlement fails, the customer was never charged: record the loss
    // explicitly and do not return the result.
    let settlementTx: string | null = null;
    let settledPayer: string | null = verified.payer;
    if (verified.settle) {
      try {
        const settlement = await verified.settle();
        settlementTx = settlement.transactionHash;
        settledPayer = settlement.payer ?? settledPayer;
      } catch (err) {
        logger.error(
          { err, transaction_id: tx.id },
          "x402 settlement failed after fulfillment",
        );
        await store.update(tx.id, {
          status: "FAILED",
          revenue: 0,
          actualCost: summary.totalCost,
          aiCost: summary.aiCost,
          searchCost: summary.searchCost,
          otherCost: summary.otherCost,
          grossProfit: -summary.totalCost,
          grossMargin: null,
          latencyMs: Date.now() - startedAt,
          errorCode: "PAYMENT_FAILED",
        });
        return {
          kind: "error",
          code: "PAYMENT_FAILED",
          statusCode: 402,
          message:
            err instanceof PaymentError
              ? err.message
              : "Payment settlement failed.",
        };
      }
    }

    const updated = await store.update(tx.id, {
      confidenceScore,
      sourceCount,
      status: "COMPLETED",
      ...(verified.settle
        ? { paymentStatus: "settled", settlementTx, payer: settledPayer }
        : {}),
      actualCost: summary.totalCost,
      aiCost: summary.aiCost,
      searchCost: summary.searchCost,
      otherCost: summary.otherCost,
      retries: summary.retries,
      grossProfit: summary.grossProfit,
      grossMargin: summary.grossMargin,
      latencyMs: Date.now() - startedAt,
      result: { ...result, transaction_id: tx.id },
    });
    logger.info(
      {
        transaction_id: tx.id,
        service,
        status: updated.status,
        quoted_price: tx.quotedPrice,
        actual_cost: summary.totalCost,
        margin: summary.grossMargin,
        duration: updated.latencyMs,
        settlement_tx: settlementTx,
      },
      "transaction completed",
    );
    return {
      kind: "completed",
      transactionId: tx.id,
      result: updated.result,
      replayed: false,
      ...(verified.settle
        ? {
            settlement: {
              transactionHash: settlementTx,
              network: tx.paymentNetwork,
            },
          }
        : {}),
    };
  } catch (err) {
    const summary = ledger.summarize(tx.quotedPrice);
    if (err instanceof BudgetExceededError) {
      await store.update(tx.id, {
        status: "BUDGET_EXCEEDED",
        // Real x402: payment is never settled when work halts — no revenue.
        ...(verified.settle ? { revenue: 0 } : {}),
        actualCost: summary.totalCost,
        aiCost: summary.aiCost,
        searchCost: summary.searchCost,
        otherCost: summary.otherCost,
        grossProfit: verified.settle ? -summary.totalCost : summary.grossProfit,
        grossMargin: verified.settle ? null : summary.grossMargin,
        latencyMs: Date.now() - startedAt,
        errorCode: "BUDGET_EXCEEDED",
      });
      logger.warn(
        {
          transaction_id: tx.id,
          service,
          status: "BUDGET_EXCEEDED",
          quoted_price: tx.quotedPrice,
          actual_cost: summary.totalCost,
          budget_limit: budget.limit,
          refused_amount: err.attempted,
        },
        "budget limit hit — work halted",
      );
      return {
        kind: "error",
        code: "BUDGET_EXCEEDED",
        statusCode: 500,
        message:
          "Fulfillment halted: completing the request would exceed the hard cost budget. Transaction flagged for refund review.",
      };
    }
    const errorCode = err instanceof ApiError ? err.code : "INTERNAL_ERROR";
    await store.update(tx.id, {
      status: "FAILED",
      // Real x402: payment is never settled when work fails — no revenue.
      ...(verified.settle ? { revenue: 0 } : {}),
      actualCost: summary.totalCost,
      aiCost: summary.aiCost,
      searchCost: summary.searchCost,
      otherCost: summary.otherCost,
      grossProfit: verified.settle ? -summary.totalCost : summary.grossProfit,
      grossMargin: verified.settle ? null : summary.grossMargin,
      latencyMs: Date.now() - startedAt,
      errorCode,
    });
    if (err instanceof ApiError) {
      return {
        kind: "error",
        code: err.code,
        statusCode: err.statusCode,
        message: err.message,
      };
    }
    throw err;
  }
}
