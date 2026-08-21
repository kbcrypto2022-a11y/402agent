import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Agent402Config } from "../config";
import type {
  RequestSurface,
  ServiceName,
  TransactionStore,
} from "../database/types";
import { issueTestPayment, PaymentError } from "../payments/x402/mock";
import type { PaymentProcessor } from "../payments/x402/processor";
import { buildQuote, UnprofitableRequestError } from "../pricing/engine";
import { ApiError, errorBody } from "../security/errors";
import type { FulfillFn } from "../services/fulfillment";
import { handleServiceRequest } from "./flow";

const SERVICES: readonly ServiceName[] = ["search", "read", "verify"] as const;
const DEFAULT_CLIENT_LABEL = "unattributed";
const CLIENT_LABEL_MAX_LENGTH = 48;
const ATTRIBUTION_LABELS = new Set([
  "quickstart-typescript",
  "quickstart-python",
]);

/**
 * Allows opt-in aggregate integration attribution without retaining personal
 * data. Labels are intentionally tiny, normalized, and never inferred from
 * IPs, user agents, wallets, cookies, or request bodies.
 */
function clientLabel(req: Request): string {
  const raw = req.header("X-Agent402-Client")?.trim().toLowerCase() ?? "";
  if (!raw || raw.length > CLIENT_LABEL_MAX_LENGTH) return DEFAULT_CLIENT_LABEL;
  return ATTRIBUTION_LABELS.has(raw) ? raw : DEFAULT_CLIENT_LABEL;
}

const serviceBodySchemas: Record<ServiceName, z.ZodTypeAny> = {
  search: z.object({ query: z.string().min(1).max(2000) }),
  read: z.object({ url: z.string().url().max(4000) }),
  verify: z.object({ claim: z.string().min(1).max(4000) }),
};

export function createApiRouter(
  config: Agent402Config,
  store: TransactionStore,
  processor: PaymentProcessor,
  fulfiller?: FulfillFn,
): Router {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "agent402",
      version: "0.1.0",
      payment_mode: config.paymentMode,
      time: new Date().toISOString(),
    });
  });

  router.get("/pricing", (_req: Request, res: Response) => {
    const services = SERVICES.map((service) => {
      const quote = buildQuote(config, service);
      return {
        service,
        price_usd: quote.price,
        payment_asset: config.paymentAsset,
        payment_network: config.paymentNetwork,
        payment_mode: config.paymentMode,
      };
    });
    res.json({
      pricing: services,
      note: "Prices are quoted per request via HTTP 402 payment requirements.",
    });
  });

  router.use(
    createPaidServiceRouter(
      config,
      store,
      processor,
      fulfiller,
      "/api/v1",
    ),
  );

  // TEST-MODE ONLY: simulate a customer wallet paying a quoted transaction.
  router.post("/payments/test-pay", async (req: Request, res: Response, next) => {
    try {
      if (config.paymentMode !== "test") {
        throw new ApiError(
          403,
          "PAYMENT_FAILED",
          "Test payments are disabled outside PAYMENT_MODE=test.",
        );
      }
      const schema = z.object({ transaction_id: z.string().min(1) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "INVALID_REQUEST", "transaction_id required");
      }
      const tx = await store.get(parsed.data.transaction_id);
      if (!tx) throw new ApiError(404, "NOT_FOUND", "Transaction not found");
      if (tx.status !== "PAYMENT_REQUIRED") {
        throw new ApiError(
          409,
          "PAYMENT_FAILED",
          `Transaction is ${tx.status}; it cannot be paid.`,
        );
      }
      const payment = issueTestPayment(config, tx.id, tx.quotedPrice);
      res.json({
        transaction_id: tx.id,
        amount_usd: tx.quotedPrice,
        x_payment_header: payment.header,
        note: "TEST payment — retry the service request with this value in the X-PAYMENT header.",
      });
    } catch (err) {
      next(err);
    }
  });

  // Read-only transaction listing (economics visibility; admin UI is a later phase).
  router.get("/transactions", async (_req: Request, res: Response, next) => {
    try {
      const rows = await store.list(50);
      res.json({
        transactions: rows.map((t) => ({
          id: t.id,
          created_at: t.createdAt,
          service: t.service,
          status: t.status,
          payment_mode: t.paymentMode,
          quoted_price: t.quotedPrice,
          revenue: t.revenue,
          estimated_cost: t.estimatedCost,
          actual_cost: t.actualCost,
          gross_profit: t.grossProfit,
          gross_margin: t.grossMargin,
          ai_cost: t.aiCost,
          search_cost: t.searchCost,
          other_cost: t.otherCost,
          error_code: t.errorCode,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function createPaidServiceRouter(
  config: Agent402Config,
  store: TransactionStore,
  processor: PaymentProcessor,
  fulfiller: FulfillFn | undefined,
  publicRoutePath: string,
  paymentNamespace?: string,
  options: { validateBodyAfterPayment?: boolean } = {},
): Router {
  const router = Router();
  const requestSurface: RequestSurface =
    paymentNamespace === "cdp" ? "cdp" : "x402";

  // Service endpoints — return 402 until payment is attached and verified.
  for (const service of SERVICES) {
    router.post(`/${service}`, async (req: Request, res: Response, next) => {
      try {
        const paymentHeader = processor.extractHeader((name) =>
          req.header(name) ?? undefined,
        );
        const validateBody = (body: unknown) => {
          const parsed = serviceBodySchemas[service].safeParse(body);
          if (parsed.success) return { valid: true as const, data: parsed.data };
          return {
            valid: false as const,
            message: `Invalid ${service} request: ${parsed.error.issues[0]?.message ?? "bad input"}`,
          };
        };

        // The standard x402.org surface keeps its established behavior:
        // validate application input before creating a quote. The separate CDP
        // surface defers this until a supplied payment has been verified so
        // Bazaar's bodyless validation probe receives the 402 metadata first.
        let body = req.body;
        if (!options.validateBodyAfterPayment) {
          const validation = validateBody(req.body);
          if (!validation.valid) {
            throw new ApiError(400, "INVALID_REQUEST", validation.message);
          }
          body = validation.data;
        }

        const outcome = await handleServiceRequest({
          config,
          store,
          processor,
          service,
          body,
          paymentHeader,
          resourceUrl: config.publicUrl
            ? `${config.publicUrl.replace(/\/+$/, "")}${publicRoutePath}/${service}`
            : `${req.protocol}://${req.get("host") ?? "agent402"}${req.baseUrl}/${service}`,
          paymentNamespace,
          requestSurface,
          clientLabel: clientLabel(req),
          ...(options.validateBodyAfterPayment
            ? { validateBodyAfterPayment: validateBody }
            : {}),
          ...(fulfiller ? { fulfiller } : {}),
        });
        if (outcome.kind === "payment_required") {
          for (const [name, value] of Object.entries(
            outcome.requirements.headers,
          )) {
            res.setHeader(name, value);
          }
          res.status(402).json({
            ...outcome.requirements.body,
            transaction_id: outcome.transactionId,
          });
        } else if (outcome.kind === "completed") {
          res.json({
            transaction_id: outcome.transactionId,
            replayed: outcome.replayed,
            ...(outcome.settlement
              ? { settlement: outcome.settlement }
              : {}),
            result: outcome.result,
          });
        } else {
          res
            .status(outcome.statusCode)
            .json(errorBody(outcome.code as never, outcome.message));
        }
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}

export function isPaymentError(err: unknown): err is PaymentError {
  return err instanceof PaymentError;
}

export function isUnprofitableError(
  err: unknown,
): err is UnprofitableRequestError {
  return err instanceof UnprofitableRequestError;
}
