import express, { type Express, type Request, type Response } from "express";
import pinoHttp from "pino-http";
import { CDP_FACILITATOR_URL, getConfig, type Agent402Config } from "./config";
import type { TransactionStore } from "./database/types";
import { createApiRouter, createPaidServiceRouter } from "./api/routes";
import type { FulfillFn } from "./services/fulfillment";
import { servicesMetadata, wellKnownX402 } from "./api/docs";
import { openApiSpec } from "./api/openapi";
import { websitePageHtml, type WebsitePage } from "./api/website";
import { getBazaarSnapshot } from "./api/websiteData";
import { createAdminRouter } from "./admin";
import { MockPaymentProcessor } from "./payments/x402/mockProcessor";
import { RealX402Processor } from "./payments/x402/real";
import { createCdpFacilitatorClient } from "./payments/x402/cdp";
import type { PaymentProcessor } from "./payments/x402/processor";
import { createRateLimiter } from "./security/rateLimit";
import { ApiError, errorBody } from "./security/errors";
import { UnprofitableRequestError } from "./pricing/engine";
import { PaymentError } from "./payments/x402/mock";
import { logger } from "./utils/logger";

const BASE_PATH = "/agent402";

export function createApp(opts: {
  store: TransactionStore;
  config?: Agent402Config;
  /**
   * Real fulfiller (SEARCH/READ/VERIFY services). When omitted the safe
   * stub fulfiller runs — tests/demo only.
   */
  fulfiller?: FulfillFn;
  /** Disable request logging in tests. */
  quiet?: boolean;
  /** Payment processor override (tests). Defaults from config.paymentMode. */
  processor?: PaymentProcessor;
  /** CDP payment processor override (tests). */
  cdpProcessor?: PaymentProcessor;
}): Express {
  const config = opts.config ?? getConfig();
  const app: Express = express();
  app.disable("x-powered-by");

  if (!opts.quiet) {
    app.use(
      pinoHttp({
        logger,
        serializers: {
          req(req) {
            return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
          },
          res(res) {
            return { statusCode: res.statusCode };
          },
        },
      }),
    );
  }

  // Request size limit (security requirement).
  app.use(express.json({ limit: "64kb" }));
  app.use(createRateLimiter(config));

  let processor = opts.processor;
  if (!processor) {
    if (config.paymentMode === "test") {
      processor = new MockPaymentProcessor(config);
    } else if (config.paymentMode === "testnet") {
      processor = new RealX402Processor(config);
    } else if (config.paymentMode === "production") {
      // Production uses the CDP facilitator, which requires a signed JWT on
      // every call (including the initial /supported discovery).  Pass the
      // authenticated client explicitly; leaving it unset would fall back to
      // a plain HTTP client that receives a 401 from the CDP endpoint.
      processor = new RealX402Processor(config, createCdpFacilitatorClient());
    } else {
      throw new Error(
        `Unsupported PAYMENT_MODE "${config.paymentMode}".`,
      );
    }
  }

  const renderWebsitePage = async (
    req: Request,
    res: Response,
    page: WebsitePage,
    service?: string,
  ) => {
    const origin = `${req.protocol}://${req.get("host") ?? "localhost"}`;
    const baseUrl = config.publicUrl ?? `${origin}${BASE_PATH}`;
    const bazaar = await getBazaarSnapshot(config);
    res.type("html").send(
      websitePageHtml({ page, basePath: BASE_PATH, baseUrl, config, bazaar, service }),
    );
  };

  // Root-level discovery routes — registered before BASE_PATH so they live at
  // the domain root (e.g. https://402agent.ai/openapi.json) rather than under
  // /agent402.  Both delegate to the same canonical functions used by the
  // existing /agent402/… paths — no spec duplication is possible.

  // OpenAPI 3.1 spec at the canonical root path.  Identical origin-derivation
  // logic to GET /agent402/openapi.json so the two routes are always in sync.
  app.get("/openapi.json", (req: Request, res: Response) => {
    const origin = config.publicUrl
      ? config.publicUrl.replace(/\/agent402\/?$/, "")
      : `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(openApiSpec(config, origin));
  });

  // x402 service-discovery document at the canonical root-level well-known path.
  // All fields are derived from the live config and pricing engine — nothing
  // is hard-coded here. CORS is open so any cross-origin agent can fetch it.
  app.get("/.well-known/x402", (req: Request, res: Response) => {
    const derivedBase = `${req.protocol}://${req.get("host") ?? "localhost"}${BASE_PATH}`;
    const baseUrl = config.publicUrl ?? derivedBase;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(wellKnownX402(config, baseUrl));
  });

  // Make the bare domain machine-discoverable without changing the visible
  // /agent402 website. The links point to the canonical discovery documents
  // above and the redirect reuses the existing website route.
  app.get("/", (_req: Request, res: Response) => {
    res.setHeader(
      "Link",
      [
        '</.well-known/x402>; rel="x402"',
        '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"',
      ].join(", "),
    );
    res.redirect(BASE_PATH);
  });

  // Public website presentation. It consumes the same live metadata used by
  // the API and leaves all paid service and payment routes unchanged.
  app.get([BASE_PATH, `${BASE_PATH}/`], async (req: Request, res: Response) => {
    // Machine-readable discovery pointer for x402-aware crawlers landing on
    // the human-facing root. Does not alter visible page design.
    res.setHeader("Link", '</.well-known/x402>; rel="x402"');
    await renderWebsitePage(req, res, "home");
  });
  app.get(`${BASE_PATH}/services`, async (req: Request, res: Response) => {
    await renderWebsitePage(req, res, "services");
  });
  app.get(
    `${BASE_PATH}/services/:service`,
    async (req: Request, res: Response, next) => {
      const rawService = req.params["service"];
      const service = Array.isArray(rawService) ? rawService[0] : rawService;
      if (!["search", "read", "verify"].includes(service)) {
        next();
        return;
      }
      await renderWebsitePage(req, res, "service", service);
    },
  );
  app.get(`${BASE_PATH}/payments`, async (req: Request, res: Response) => {
    await renderWebsitePage(req, res, "payments");
  });
  app.get(`${BASE_PATH}/bazaar`, async (req: Request, res: Response) => {
    await renderWebsitePage(req, res, "bazaar");
  });
  app.get(`${BASE_PATH}/status`, async (req: Request, res: Response) => {
    await renderWebsitePage(req, res, "status");
  });
  app.get(`${BASE_PATH}/docs`, async (req: Request, res: Response) => {
    await renderWebsitePage(req, res, "docs");
  });
  app.get(`${BASE_PATH}/docs/quickstart`, async (req: Request, res: Response) => {
    await renderWebsitePage(req, res, "quickstart");
  });
  app.get(`${BASE_PATH}/openapi.json`, (req: Request, res: Response) => {
    // Prefer the configured canonical public URL so external agents see the
    // real address rather than the Replit dev proxy or localhost.
    const origin = config.publicUrl
      ? config.publicUrl.replace(/\/agent402\/?$/, "")
      : `${req.protocol}://${req.get("host") ?? "localhost"}`;
    res.setHeader("Access-Control-Allow-Origin", "*");
    // openApiSpec uses config.publicUrl internally when set; origin is the
    // request-derived fallback.
    res.json(openApiSpec(config, origin));
  });
  app.get(`${BASE_PATH}/api/v1/services`, (req: Request, res: Response) => {
    // Use the canonical public URL when configured; fall back to the
    // request-derived origin so relative endpoint links are always absolute.
    const derivedBase = `${req.protocol}://${req.get("host") ?? "localhost"}${BASE_PATH}`;
    const baseUrl = config.publicUrl ?? derivedBase;
    res.json(servicesMetadata(config, baseUrl));
  });

  // Admin dashboard (authenticated).
  app.use(BASE_PATH, createAdminRouter(config, opts.store, BASE_PATH));

  app.use(
    `${BASE_PATH}/api/v1`,
    createApiRouter(config, opts.store, processor, opts.fulfiller),
  );

  if (
    config.paymentMode === "testnet" ||
    config.paymentMode === "production" ||
    opts.cdpProcessor
  ) {
    const cdpConfig: Agent402Config = {
      ...config,
      facilitatorUrl: CDP_FACILITATOR_URL,
    };
    const cdpProcessor =
      opts.cdpProcessor ??
      new RealX402Processor(
        cdpConfig,
        createCdpFacilitatorClient(),
        {
          configuredRequirements: true,
          serviceBrand: "402Agent",
          serviceTag: "402agent",
          // CDP currently rejects x402 v2 resource descriptions over 500 chars.
          maxResourceDescriptionLength: 480,
        },
      );
    app.use(
      `${BASE_PATH}/cdp/v1`,
      createPaidServiceRouter(
        cdpConfig,
        opts.store,
        cdpProcessor,
        opts.fulfiller,
        "/cdp/v1",
        "cdp",
        { validateBodyAfterPayment: true },
      ),
    );
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json(errorBody("NOT_FOUND", "Not found"));
  });

  // Safe error handling: stable codes, no stack traces to clients.
  app.use(
    (
      err: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ApiError) {
        res.status(err.statusCode).json(errorBody(err.code, err.message));
        return;
      }
      if (err instanceof UnprofitableRequestError) {
        res
          .status(503)
          .json(
            errorBody(
              "UNPROFITABLE_REQUEST",
              "This request cannot currently be served within profitability limits.",
            ),
          );
        return;
      }
      if (err instanceof PaymentError) {
        res.status(402).json(errorBody(err.code, err.message));
        return;
      }
      if (
        err !== null &&
        typeof err === "object" &&
        "type" in err &&
        (err as { type?: string }).type === "entity.too.large"
      ) {
        res.status(413).json(errorBody("INVALID_REQUEST", "Request too large"));
        return;
      }
      if (err instanceof SyntaxError) {
        res.status(400).json(errorBody("INVALID_REQUEST", "Malformed JSON"));
        return;
      }
      logger.error({ err }, "unhandled error");
      res.status(500).json(errorBody("INTERNAL_ERROR", "Internal error"));
    },
  );

  return app;
}
