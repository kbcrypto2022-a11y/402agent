import { createHash, randomUUID, randomBytes } from "node:crypto";

/** Stable hash of a request body for idempotency / duplicate detection. */
export function hashRequest(service: string, body: unknown): string {
  return createHash("sha256")
    .update(service)
    .update(JSON.stringify(body ?? {}))
    .digest("hex");
}

export function newTransactionId(): string {
  return `tx_${randomUUID()}`;
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
