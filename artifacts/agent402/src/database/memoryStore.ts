import { assertTransition } from "./states";
import type {
  ClaimOptions,
  NewTransaction,
  ServiceName,
  TransactionRecord,
  TransactionStore,
  TransactionUpdate,
} from "./types";

/** In-memory store used by automated tests (same semantics as Postgres store). */
export class MemoryTransactionStore implements TransactionStore {
  private readonly rows = new Map<string, TransactionRecord>();

  async create(tx: NewTransaction): Promise<TransactionRecord> {
    if (this.rows.has(tx.id)) {
      throw new Error(`Duplicate transaction id: ${tx.id}`);
    }
    const now = new Date();
    const record: TransactionRecord = {
      ...tx,
      requestSurface: tx.requestSurface ?? "x402",
      clientLabel: tx.clientLabel ?? "unattributed",
      createdAt: now,
      updatedAt: now,
      paymentStatus: "unpaid",
      paymentReference: null,
      authorizationNonce: null,
      revenue: 0,
      actualCost: 0,
      grossProfit: 0,
      grossMargin: null,
      aiCost: 0,
      searchCost: 0,
      otherCost: 0,
      retries: 0,
      confidenceScore: null,
      sourceCount: null,
      latencyMs: null,
      errorCode: null,
      settlementTx: null,
      payer: null,
      result: null,
    };
    this.rows.set(tx.id, record);
    return { ...record };
  }

  async get(id: string): Promise<TransactionRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async update(
    id: string,
    update: TransactionUpdate,
  ): Promise<TransactionRecord> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`Transaction not found: ${id}`);
    if (update.status && update.status !== row.status) {
      assertTransition(row.status, update.status);
    }
    const next: TransactionRecord = {
      ...row,
      ...update,
      updatedAt: new Date(),
    };
    this.rows.set(id, next);
    return { ...next };
  }

  async claimForProcessing(
    id: string,
    opts: ClaimOptions,
  ): Promise<TransactionRecord | null> {
    // Synchronous check-and-set mirrors the Postgres conditional UPDATE.
    const row = this.rows.get(id);
    if (!row) return null;
    if (row.status !== "PAYMENT_REQUIRED" || row.paymentReference !== null) {
      return null;
    }
    // Enforce UNIQUE on payment_reference and (when provided) authorization_nonce.
    for (const other of this.rows.values()) {
      if (other.paymentReference === opts.paymentReference) return null;
      if (
        opts.authorizationNonce &&
        other.authorizationNonce === opts.authorizationNonce
      ) {
        return null;
      }
    }
    const next: TransactionRecord = {
      ...row,
      status: "PROCESSING",
      paymentStatus: opts.paymentStatus ?? "verified_test",
      paymentReference: opts.paymentReference,
      authorizationNonce: opts.authorizationNonce ?? null,
      revenue: opts.revenue,
      payer: opts.payer ?? row.payer,
      updatedAt: new Date(),
    };
    this.rows.set(id, next);
    return { ...next };
  }

  async findByPaymentReference(
    ref: string,
  ): Promise<TransactionRecord | null> {
    for (const row of this.rows.values()) {
      if (row.paymentReference === ref) return { ...row };
    }
    return null;
  }

  async findPendingByRequestHash(
    service: ServiceName,
    requestHash: string,
  ): Promise<TransactionRecord | null> {
    const matches = [...this.rows.values()]
      .filter(
        (r) =>
          r.service === service &&
          r.requestHash === requestHash &&
          r.status === "PAYMENT_REQUIRED",
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ? { ...matches[0] } : null;
  }

  async list(limit = 100): Promise<TransactionRecord[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listSince(since: Date, limit = 1000): Promise<TransactionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.createdAt.getTime() >= since.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
