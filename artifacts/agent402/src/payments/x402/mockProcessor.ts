/**
 * Demo-mode payment processor (PAYMENT_MODE=test).
 *
 * Wraps the HMAC-signed local test-token flow in the PaymentProcessor
 * interface. No network, no funds — used for demos and automated tests.
 * Transactions carry payment_mode="test" and are never mixed with real
 * (testnet or production) revenue.
 */

import type { Agent402Config } from "../../config";
import type {
  ServiceName,
  TransactionRecord,
  TransactionStore,
} from "../../database/types";
import {
  buildPaymentRequirements,
  verifyTestPayment,
} from "./mock";
import type {
  PaymentProcessor,
  PreparedRequirements,
  VerifiedPaymentInfo,
} from "./processor";

export class MockPaymentProcessor implements PaymentProcessor {
  readonly mode = "test" as const;
  readonly paymentHeaderName = "X-PAYMENT";

  constructor(private readonly config: Agent402Config) {}

  extractHeader(
    get: (name: string) => string | undefined,
  ): string | undefined {
    return get("X-PAYMENT");
  }

  async buildRequirements(
    tx: TransactionRecord,
    _resourceUrl: string,
  ): Promise<PreparedRequirements> {
    const requirements = buildPaymentRequirements(
      this.config,
      tx.id,
      tx.service,
      tx.quotedPrice,
    );
    return {
      body: { ...requirements, transaction_id: tx.id },
      headers: {},
    };
  }

  async locateTransaction(
    header: string,
    _service: ServiceName,
    _requestHash: string,
    store: TransactionStore,
  ): Promise<TransactionRecord | null> {
    // Test tokens embed the transaction id: x402-test.<txId>.<nonce>.<amount>.<sig>
    const parts = header.split(".");
    const txId = parts.length === 5 ? parts[1]! : "";
    return txId ? store.get(txId) : null;
  }

  async verify(
    header: string,
    tx: TransactionRecord,
  ): Promise<VerifiedPaymentInfo> {
    const verified = verifyTestPayment(header, tx.id, tx.quotedPrice);
    return {
      reference: verified.reference,
      authorizationNonce: null, // mock tokens do not use EIP-3009 authorizations
      payer: null,
      paymentStatus: "verified_test",
      settle: null,
    };
  }

  referenceFor(header: string): string | null {
    const parts = header.split(".");
    return parts.length === 5 ? `test-pay-${parts[2]}` : null;
  }
}
