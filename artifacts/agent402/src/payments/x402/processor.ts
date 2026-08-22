/**
 * Payment processor abstraction.
 *
 * Two implementations exist behind this interface:
 *  - MockPaymentProcessor (PAYMENT_MODE=test): demo mode, HMAC-signed local
 *    test tokens, no network access, X-PAYMENT header.
 *  - RealX402Processor (PAYMENT_MODE=testnet or production): the current
 *    official x402 v2 flow — base64 PAYMENT-REQUIRED / PAYMENT-SIGNATURE
 *    headers, facilitator verification and on-chain settlement in USDC.
 *
 * The orchestration in api/flow.ts is identical for both: quote → 402 →
 * verify → atomic claim → hard budget → work → (settle) → record economics.
 */

import type {
  ServiceName,
  TransactionRecord,
  TransactionStore,
} from "../../database/types";

export interface PreparedRequirements {
  /** JSON body of the 402 response. */
  body: Record<string, unknown>;
  /** Extra response headers to set on the 402 (e.g. PAYMENT-REQUIRED). */
  headers: Record<string, string>;
}

export interface SettlementInfo {
  transactionHash: string | null;
  network: string;
  payer: string | null;
}

export interface VerifiedPaymentInfo {
  /** Unique reference consumed exactly once (duplicate-payment protection). */
  reference: string;
  /**
   * EIP-3009 authorization nonce extracted from the verified payload.
   *
   * Used as a secondary, scheme-level idempotency key: even when a client
   * re-signs the same authorization intent with a fresh outer envelope
   * (producing a different `reference` hash), the nonce stays constant and
   * the UNIQUE constraint on `authorization_nonce` blocks double-settlement.
   * Null for the mock processor, which does not use EIP-3009 authorizations.
   */
  authorizationNonce: string | null;
  payer: string | null;
  /** payment_status recorded on the transaction when the claim wins. */
  paymentStatus: string;
  /**
   * Settle the payment (moves funds). Null for the mock processor. Called
   * AFTER fulfillment succeeds (x402 `authorization` flow: verify → work →
   * settle). Throws PaymentError when settlement fails.
   */
  settle: (() => Promise<SettlementInfo>) | null;
}

export interface PaymentProcessor {
  readonly mode: "test" | "testnet" | "production";
  /** Name of the request header carrying the payment (for docs/errors). */
  readonly paymentHeaderName: string;
  /** Pull the payment header off a request, if present. */
  extractHeader(get: (name: string) => string | undefined): string | undefined;
  /** Build the 402 payment-required response for a quoted transaction. */
  buildRequirements(
    tx: TransactionRecord,
    resourceUrl: string,
  ): Promise<PreparedRequirements>;
  /** Find the pending transaction a payment header pays for. */
  locateTransaction(
    header: string,
    service: ServiceName,
    requestHash: string,
    store: TransactionStore,
  ): Promise<TransactionRecord | null>;
  /** Verify the payment against the quoted transaction. Throws PaymentError. */
  verify(header: string, tx: TransactionRecord): Promise<VerifiedPaymentInfo>;
  /**
   * Derive the payment reference from a header without verification —
   * used to replay cached results for already-consumed payments.
   */
  referenceFor(header: string): string | null;
}
