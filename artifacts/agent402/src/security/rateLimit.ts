import type { NextFunction, Request, Response } from "express";
import type { Agent402Config } from "../config";
import { errorBody } from "./errors";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory fixed-window rate limiter (per client IP). Protects
 * against retry storms and repeated unpaid requests. Configurable via
 * RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX_REQUESTS.
 */
export function createRateLimiter(config: Agent402Config) {
  const buckets = new Map<string, Bucket>();

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.rateLimitWindowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > config.rateLimitMaxRequests) {
      res
        .status(429)
        .json(errorBody("RATE_LIMITED", "Too many requests. Slow down."));
      return;
    }
    // Opportunistic cleanup to bound memory.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }
    next();
  };
}
