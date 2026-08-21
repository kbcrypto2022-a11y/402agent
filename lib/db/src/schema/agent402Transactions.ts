import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  real,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Agent402 transaction ledger. One row per customer request that reached
 * QUOTED state. Monetary columns are USD with 6 decimal places.
 */
export const agent402TransactionsTable = pgTable("agent402_transactions", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  service: text("service").notNull(),
  requestHash: text("request_hash").notNull(),
  quotedPrice: numeric("quoted_price", { precision: 14, scale: 6 }).notNull(),
  paymentAsset: text("payment_asset").notNull(),
  paymentNetwork: text("payment_network").notNull(),
  /** Public payment surface that created this quote (standard x402 or CDP). */
  requestSurface: text("request_surface").notNull().default("x402"),
  /**
   * Optional, bounded caller-supplied integration label. This deliberately
   * excludes IP addresses, user agents, cookies, wallet data, and identities.
   */
  clientLabel: text("client_label").notNull().default("unattributed"),
  paymentMode: text("payment_mode").notNull().default("test"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentReference: text("payment_reference").unique(),
  revenue: numeric("revenue", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  estimatedCost: numeric("estimated_cost", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  budgetedCost: numeric("budgeted_cost", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  actualCost: numeric("actual_cost", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  grossProfit: numeric("gross_profit", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  grossMargin: numeric("gross_margin", { precision: 8, scale: 6 }),
  aiCost: numeric("ai_cost", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  searchCost: numeric("search_cost", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  otherCost: numeric("other_cost", { precision: 14, scale: 6 })
    .notNull()
    .default("0"),
  retries: integer("retries").notNull().default(0),
  status: text("status").notNull(),
  confidenceScore: real("confidence_score"),
  sourceCount: integer("source_count"),
  latencyMs: integer("latency_ms"),
  errorCode: text("error_code"),
  /** On-chain settlement transaction hash (real x402 payments only). */
  settlementTx: text("settlement_tx"),
  /** Payer wallet address reported by the facilitator (real x402 only). */
  payer: text("payer"),
  /**
   * EIP-3009 authorization nonce (real x402 only). Stored after verification
   * as a secondary idempotency key: the UNIQUE constraint prevents two rows
   * from settling with the same nonce, even when the client re-signs the same
   * authorization intent with a fresh outer signature.
   */
  authorizationNonce: text("authorization_nonce").unique(),
  result: jsonb("result"),
});

export const insertAgent402TransactionSchema = createInsertSchema(
  agent402TransactionsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertAgent402Transaction = z.infer<
  typeof insertAgent402TransactionSchema
>;
export type Agent402Transaction =
  typeof agent402TransactionsTable.$inferSelect;
