import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../utils/logger";

/**
 * Idempotent schema provisioning, run at startup so a clean database
 * (including a fresh production deployment) always has the transaction
 * table before the server accepts traffic. Kept in lockstep with
 * `lib/db/src/schema/agent402Transactions.ts`.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent402_transactions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  service text NOT NULL,
  request_hash text NOT NULL,
  quoted_price numeric(14,6) NOT NULL,
  payment_asset text NOT NULL,
  payment_network text NOT NULL,
  request_surface text NOT NULL DEFAULT 'x402',
  client_label text NOT NULL DEFAULT 'unattributed',
  payment_mode text NOT NULL DEFAULT 'test',
  payment_status text NOT NULL DEFAULT 'unpaid',
  payment_reference text UNIQUE,
  revenue numeric(14,6) NOT NULL DEFAULT '0',
  estimated_cost numeric(14,6) NOT NULL DEFAULT '0',
  budgeted_cost numeric(14,6) NOT NULL DEFAULT '0',
  actual_cost numeric(14,6) NOT NULL DEFAULT '0',
  gross_profit numeric(14,6) NOT NULL DEFAULT '0',
  gross_margin numeric(8,6),
  ai_cost numeric(14,6) NOT NULL DEFAULT '0',
  search_cost numeric(14,6) NOT NULL DEFAULT '0',
  other_cost numeric(14,6) NOT NULL DEFAULT '0',
  retries integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  confidence_score real,
  source_count integer,
  latency_ms integer,
  error_code text,
  result jsonb,
  settlement_tx text,
  payer text
);
ALTER TABLE agent402_transactions ADD COLUMN IF NOT EXISTS settlement_tx text;
ALTER TABLE agent402_transactions ADD COLUMN IF NOT EXISTS payer text;
ALTER TABLE agent402_transactions ADD COLUMN IF NOT EXISTS authorization_nonce text;
ALTER TABLE agent402_transactions ADD COLUMN IF NOT EXISTS request_surface text NOT NULL DEFAULT 'x402';
ALTER TABLE agent402_transactions ADD COLUMN IF NOT EXISTS client_label text NOT NULL DEFAULT 'unattributed';
CREATE UNIQUE INDEX IF NOT EXISTS agent402_transactions_authorization_nonce_key
  ON agent402_transactions (authorization_nonce)
  WHERE authorization_nonce IS NOT NULL;
`;

export async function ensureSchema(): Promise<void> {
  await db.execute(sql.raw(SCHEMA_SQL));
  logger.info("agent402_transactions schema ensured");
}
