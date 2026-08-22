import { createApp } from "./app";
import { getConfig } from "./config";
import { PgTransactionStore } from "./database/pgStore";
import { logger } from "./utils/logger";

const rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const config = getConfig();

const { createRealFulfiller } = await import("./services/fulfillment");
const app = createApp({
  store: new PgTransactionStore(),
  config,
  fulfiller: createRealFulfiller(config),
});

// Provision the transaction table before accepting traffic (idempotent).
const { ensureSchema } = await import("./database/provision");
await ensureSchema();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port, paymentMode: config.paymentMode }, "Agent402 listening");
});
