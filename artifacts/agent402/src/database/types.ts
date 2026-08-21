import type { TransactionState } from "./states";

export type ServiceName = "search" | "read" | "verify";
export type RequestSurface = "x402" | "cdp";

export interface TransactionRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  service: ServiceName;
  requestHash: string;
  /** Price quoted to the customer (USD). */
  quotedPrice: number;
  paymentAsset: string;
  paymentNetwork: string;
  /** Public payment surface that created the transaction. */
  requestSurface: RequestSurface;
  /** Optional bounded integration label; never a person or device identifier. */
  clientLabel: string;
  /** "test" | "production" — test transactions never mix with real revenue. */
  paymentMode: string;
  paymentStatus: string;
  paymentReference: string | null;
  /** Revenue actually received (USD). 0 until payment verified. */
  revenue: number;
  estimatedCost: number;
  /** Budgeted cost = estimate * (1 + safety buffer). */
  budgetedCost: number;
  actualCost: number;
  grossProfit: number;
  grossMargin: number | null;
  aiCost: number;
  searchCost: number;
  otherCost: number;
  retries: number;
  status: TransactionState;
  confidenceScore: number | null;
  sourceCount: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  /** On-chain settlement transaction hash (real x402 payments only). */
  settlementTx: string | null;
  /** Payer wallet address reported by the facilitator (real x402 only). */
  payer: string | null;
  /**
   * EIP-3009 authorization nonce (real x402 only). Stored after verification
   * as a secondary duplicate-settlement guard: a UNIQUE constraint on this
   * column prevents two transactions from settling with the same nonce, even
   * when the client re-signs with a fresh outer envelope.
   */
  authorizationNonce: string | null;
  /** Cached result for idempotent replay of duplicate paid requests. */
  result: unknown | null;
}

export interface TransactionUpdate {
  status?: TransactionState;
  paymentStatus?: string;
  paymentReference?: string | null;
  authorizationNonce?: string | null;
  revenue?: number;
  actualCost?: number;
  grossProfit?: number;
  grossMargin?: number | null;
  aiCost?: number;
  searchCost?: number;
  otherCost?: number;
  retries?: number;
  confidenceScore?: number | null;
  sourceCount?: number | null;
  latencyMs?: number | null;
  errorCode?: string | null;
  settlementTx?: string | null;
  payer?: string | null;
  result?: unknown | null;
}

export interface NewTransaction {
  id: string;
  service: ServiceName;
  requestHash: string;
  quotedPrice: number;
  paymentAsset: string;
  paymentNetwork: string;
  /** Defaults preserve compatibility with direct store tests. */
  requestSurface?: RequestSurface;
  /** Defaults to unattributed; only an opted-in bounded label is stored. */
  clientLabel?: string;
  paymentMode: string;
  estimatedCost: number;
  budgetedCost: number;
  status: TransactionState;
}

export interface ClaimOptions {
  paymentReference: string;
  revenue: number;
  /** Recorded payment_status when the claim wins (e.g. verified_test / verified_x402). */
  paymentStatus?: string;
  /** Payer wallet address, when known at verification time. */
  payer?: string | null;
  /**
   * EIP-3009 authorization nonce (real x402 only). Stored with a UNIQUE
   * constraint to block double-settlement when a client re-signs the same
   * authorization intent with a fresh outer signature.
   */
  authorizationNonce?: string | null;
}

export interface TransactionStore {
  create(tx: NewTransaction): Promise<TransactionRecord>;
  /**
   * Atomically claim a PAYMENT_REQUIRED transaction for fulfillment
   * (composite PAYMENT_VERIFIED -> PROCESSING transition). Exactly one
   * concurrent caller wins; all others receive null. Also fails (null) if
   * the payment reference was already consumed by any transaction.
   */
  claimForProcessing(
    id: string,
    opts: ClaimOptions,
  ): Promise<TransactionRecord | null>;
  get(id: string): Promise<TransactionRecord | null>;
  /** Update with state-machine enforcement when `status` changes. */
  update(id: string, update: TransactionUpdate): Promise<TransactionRecord>;
  findByPaymentReference(ref: string): Promise<TransactionRecord | null>;
  /**
   * Newest PAYMENT_REQUIRED transaction matching a service + request hash.
   * Used to bind an incoming x402 payment (which carries no transaction id)
   * back to the quote it pays for.
   */
  findPendingByRequestHash(
    service: ServiceName,
    requestHash: string,
  ): Promise<TransactionRecord | null>;
  list(limit?: number): Promise<TransactionRecord[]>;
  /** Transactions created at or after `since` (newest first). */
  listSince(since: Date, limit?: number): Promise<TransactionRecord[]>;
}
