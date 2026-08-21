/** Stable machine-readable error codes. */
export const ERROR_CODES = [
  "INVALID_REQUEST",
  "PAYMENT_REQUIRED",
  "PAYMENT_FAILED",
  "PAYMENT_NOT_VERIFIED",
  "DUPLICATE_PAYMENT",
  "SOURCE_UNAVAILABLE",
  "INSUFFICIENT_EVIDENCE",
  "PROVIDER_ERROR",
  "BUDGET_EXCEEDED",
  "RATE_LIMITED",
  "UNPROFITABLE_REQUEST",
  "NOT_FOUND",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}
