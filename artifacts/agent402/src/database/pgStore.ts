import { db, agent402TransactionsTable } from "@workspace/db";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { moneyToString } from "../utils/money";
import { assertTransition, type TransactionState } from "./states";
import type {
  ClaimOptions,
  NewTransaction,
  TransactionRecord,
  TransactionStore,
  TransactionUpdate,
} from "./types";
import type { ServiceName } from "./types";

type Row = typeof agent402TransactionsTable.$inferSelect;

function toRecord(row: Row): TransactionRecord {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    service: row.service as ServiceName,
    requestHash: row.requestHash,
    quotedPrice: Number(row.quotedPrice),
    paymentAsset: row.paymentAsset,
    paymentNetwork: row.paymentNetwork,
    requestSurface: row.requestSurface as TransactionRecord["requestSurface"],
    clientLabel: row.clientLabel,
    paymentMode: row.paymentMode,
    paymentStatus: row.paymentStatus,
    paymentReference: row.paymentReference,
    revenue: Number(row.revenue),
    estimatedCost: Number(row.estimatedCost),
    budgetedCost: Number(row.budgetedCost),
    actualCost: Number(row.actualCost),
    grossProfit: Number(row.grossProfit),
    grossMargin: row.grossMargin === null ? null : Number(row.grossMargin),
    aiCost: Number(row.aiCost),
    searchCost: Number(row.searchCost),
    otherCost: Number(row.otherCost),
    retries: row.retries,
    status: row.status as TransactionState,
    confidenceScore: row.confidenceScore,
    sourceCount: row.sourceCount,
    latencyMs: row.latencyMs,
    errorCode: row.errorCode,
    settlementTx: row.settlementTx,
    payer: row.payer,
    authorizationNonce: row.authorizationNonce ?? null,
    result: row.result,
  };
}

export class PgTransactionStore implements TransactionStore {
  async create(tx: NewTransaction): Promise<TransactionRecord> {
    const [row] = await db
      .insert(agent402TransactionsTable)
      .values({
        id: tx.id,
        service: tx.service,
        requestHash: tx.requestHash,
        quotedPrice: moneyToString(tx.quotedPrice),
        paymentAsset: tx.paymentAsset,
        paymentNetwork: tx.paymentNetwork,
        requestSurface: tx.requestSurface ?? "x402",
        clientLabel: tx.clientLabel ?? "unattributed",
        paymentMode: tx.paymentMode,
        estimatedCost: moneyToString(tx.estimatedCost),
        budgetedCost: moneyToString(tx.budgetedCost),
        status: tx.status,
      })
      .returning();
    if (!row) throw new Error("Failed to insert transaction");
    return toRecord(row);
  }

  async get(id: string): Promise<TransactionRecord | null> {
    const [row] = await db
      .select()
      .from(agent402TransactionsTable)
      .where(eq(agent402TransactionsTable.id, id));
    return row ? toRecord(row) : null;
  }

  async update(
    id: string,
    update: TransactionUpdate,
  ): Promise<TransactionRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Transaction not found: ${id}`);
    if (update.status && update.status !== current.status) {
      assertTransition(current.status, update.status);
    }
    const values: Record<string, unknown> = {};
    if (update.status !== undefined) values["status"] = update.status;
    if (update.paymentStatus !== undefined)
      values["paymentStatus"] = update.paymentStatus;
    if (update.paymentReference !== undefined)
      values["paymentReference"] = update.paymentReference;
    if (update.revenue !== undefined)
      values["revenue"] = moneyToString(update.revenue);
    if (update.actualCost !== undefined)
      values["actualCost"] = moneyToString(update.actualCost);
    if (update.grossProfit !== undefined)
      values["grossProfit"] = moneyToString(update.grossProfit);
    if (update.grossMargin !== undefined)
      values["grossMargin"] =
        update.grossMargin === null ? null : update.grossMargin.toFixed(6);
    if (update.aiCost !== undefined)
      values["aiCost"] = moneyToString(update.aiCost);
    if (update.searchCost !== undefined)
      values["searchCost"] = moneyToString(update.searchCost);
    if (update.otherCost !== undefined)
      values["otherCost"] = moneyToString(update.otherCost);
    if (update.retries !== undefined) values["retries"] = update.retries;
    if (update.confidenceScore !== undefined)
      values["confidenceScore"] = update.confidenceScore;
    if (update.sourceCount !== undefined)
      values["sourceCount"] = update.sourceCount;
    if (update.latencyMs !== undefined) values["latencyMs"] = update.latencyMs;
    if (update.errorCode !== undefined) values["errorCode"] = update.errorCode;
    if (update.settlementTx !== undefined)
      values["settlementTx"] = update.settlementTx;
    if (update.payer !== undefined) values["payer"] = update.payer;
    if (update.authorizationNonce !== undefined)
      values["authorizationNonce"] = update.authorizationNonce;
    if (update.result !== undefined) values["result"] = update.result;

    const [row] = await db
      .update(agent402TransactionsTable)
      .set(values)
      .where(eq(agent402TransactionsTable.id, id))
      .returning();
    if (!row) throw new Error(`Transaction not found: ${id}`);
    return toRecord(row);
  }

  async claimForProcessing(
    id: string,
    opts: ClaimOptions,
  ): Promise<TransactionRecord | null> {
    try {
      // Single conditional UPDATE: only one concurrent caller can move the
      // row out of PAYMENT_REQUIRED / null payment_reference. The UNIQUE
      // constraint on payment_reference additionally rejects a reference
      // already consumed by any other transaction.
      const [row] = await db
        .update(agent402TransactionsTable)
        .set({
          status: "PROCESSING",
          paymentStatus: opts.paymentStatus ?? "verified_test",
          paymentReference: opts.paymentReference,
          revenue: moneyToString(opts.revenue),
          ...(opts.payer !== undefined ? { payer: opts.payer } : {}),
          ...(opts.authorizationNonce != null
            ? { authorizationNonce: opts.authorizationNonce }
            : {}),
        })
        .where(
          and(
            eq(agent402TransactionsTable.id, id),
            eq(agent402TransactionsTable.status, "PAYMENT_REQUIRED"),
            isNull(agent402TransactionsTable.paymentReference),
          ),
        )
        .returning();
      return row ? toRecord(row) : null;
    } catch (err) {
      // Unique-violation on payment_reference => duplicate payment; treat as
      // a lost claim deterministically. Drizzle wraps the pg error, so check
      // the error chain for code 23505.
      let e: unknown = err;
      while (e !== null && typeof e === "object") {
        if ("code" in e && (e as { code?: string }).code === "23505") {
          return null;
        }
        e = (e as { cause?: unknown }).cause;
      }
      throw err;
    }
  }

  async findByPaymentReference(
    ref: string,
  ): Promise<TransactionRecord | null> {
    const [row] = await db
      .select()
      .from(agent402TransactionsTable)
      .where(eq(agent402TransactionsTable.paymentReference, ref));
    return row ? toRecord(row) : null;
  }

  async findPendingByRequestHash(
    service: ServiceName,
    requestHash: string,
  ): Promise<TransactionRecord | null> {
    const [row] = await db
      .select()
      .from(agent402TransactionsTable)
      .where(
        and(
          eq(agent402TransactionsTable.service, service),
          eq(agent402TransactionsTable.requestHash, requestHash),
          eq(agent402TransactionsTable.status, "PAYMENT_REQUIRED"),
        ),
      )
      .orderBy(desc(agent402TransactionsTable.createdAt))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async list(limit = 100): Promise<TransactionRecord[]> {
    const rows = await db
      .select()
      .from(agent402TransactionsTable)
      .orderBy(desc(agent402TransactionsTable.createdAt))
      .limit(limit);
    return rows.map(toRecord);
  }

  async listSince(since: Date, limit = 1000): Promise<TransactionRecord[]> {
    const rows = await db
      .select()
      .from(agent402TransactionsTable)
      .where(gte(agent402TransactionsTable.createdAt, since))
      .orderBy(desc(agent402TransactionsTable.createdAt))
      .limit(limit);
    return rows.map(toRecord);
  }
}
