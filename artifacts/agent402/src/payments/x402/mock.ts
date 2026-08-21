/**
 * Mocked x402 payment flow (PAYMENT_MODE=test only).
 *
 * Mirrors the x402 seller flow shape — HTTP 402 with `accepts` payment
 * requirements, an X-PAYMENT header on retry, verification before work —
 * without touching a real network or facilitator. Real testnet integration
 * replaces `MockPaymentProcessor` behind the same interface in a later phase.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Agent402Config } from "../../config";
import { newNonce } from "../../utils/hash";

export interface PaymentRequirements {
  x402Version: number;
  error: string;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    /** Amount in USD as a decimal string (mock; real x402 uses atomic units). */
    maxAmountRequired: string;
    payTo: string;
    resource: string;
    description: string;
    mimeType: string;
    maxTimeoutSeconds: number;
    extra: { transactionId: string; mode: "test" };
  }>;
}

export interface VerifiedPayment {
  transactionId: string;
  reference: string;
  amount: number;
}

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PAYMENT_FAILED"
      | "PAYMENT_NOT_VERIFIED"
      | "DUPLICATE_PAYMENT" = "PAYMENT_NOT_VERIFIED",
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

function signingKey(): string {
  // Test-mode only: deterministic local signing secret. Never used for real funds.
  return process.env["SESSION_SECRET"] ?? "agent402-test-payment-key";
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("hex");
}

export function buildPaymentRequirements(
  config: Agent402Config,
  transactionId: string,
  service: string,
  price: number,
): PaymentRequirements {
  return {
    x402Version: 2,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network: config.paymentNetwork,
        asset: config.paymentAsset,
        maxAmountRequired: price.toFixed(6),
        payTo: config.recipientAddress,
        resource: `/agent402/api/v1/${service}`,
        description: `Agent402 ${service.toUpperCase()} request (TEST MODE)`,
        mimeType: "application/json",
        maxTimeoutSeconds: 300,
        extra: { transactionId, mode: "test" },
      },
    ],
  };
}

/**
 * Simulate a customer paying a quote. Returns the X-PAYMENT header value the
 * customer sends on retry. Format: `x402-test.<txId>.<nonce>.<signature>`.
 */
export function issueTestPayment(
  config: Agent402Config,
  transactionId: string,
  amount: number,
): { header: string; reference: string } {
  if (config.paymentMode !== "test") {
    throw new PaymentError(
      "Test payments are only available when PAYMENT_MODE=test",
      "PAYMENT_FAILED",
    );
  }
  const nonce = newNonce();
  // Amount is encoded in integer micro-USD so the token stays dot-delimited.
  const amountMicro = Math.round(amount * 1_000_000);
  const payload = `${transactionId}.${nonce}.${amountMicro}`;
  const signature = sign(payload);
  return {
    header: `x402-test.${payload}.${signature}`,
    reference: `test-pay-${nonce}`,
  };
}

/**
 * Verify an X-PAYMENT header for a transaction. Enforces:
 * - test scheme + signature validity
 * - transaction match
 * - amount >= quoted price
 */
export function verifyTestPayment(
  header: string,
  expectedTransactionId: string,
  quotedPrice: number,
): VerifiedPayment {
  const parts = header.split(".");
  if (parts.length !== 5 || parts[0] !== "x402-test") {
    throw new PaymentError("Malformed X-PAYMENT header");
  }
  const [, txId, nonce, amountMicroStr, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const expectedSig = sign(`${txId}.${nonce}.${amountMicroStr}`);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PaymentError("Invalid payment signature");
  }
  if (txId !== expectedTransactionId) {
    throw new PaymentError("Payment does not match this transaction");
  }
  const amountMicro = Number(amountMicroStr);
  const amount = amountMicro / 1_000_000;
  if (!Number.isInteger(amountMicro) || amount + 1e-9 < quotedPrice) {
    throw new PaymentError("Payment amount is less than the quoted price");
  }
  return {
    transactionId: txId,
    reference: `test-pay-${nonce}`,
    amount,
  };
}
