import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
} from "../database/states";

describe("transaction state machine", () => {
  it("allows the happy path", () => {
    const path = [
      "REQUESTED",
      "QUOTED",
      "PAYMENT_REQUIRED",
      "PAYMENT_VERIFIED",
      "PROCESSING",
      "COMPLETED",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("rejects skipping payment", () => {
    expect(canTransition("QUOTED", "PROCESSING" as never)).toBe(false);
    expect(canTransition("PAYMENT_REQUIRED", "PROCESSING")).toBe(false);
    expect(() => assertTransition("REQUESTED", "COMPLETED")).toThrow(
      InvalidTransitionError,
    );
  });

  it("terminal states cannot move", () => {
    expect(canTransition("COMPLETED", "PROCESSING")).toBe(false);
    expect(canTransition("FAILED", "PROCESSING")).toBe(false);
  });

  it("budget-exceeded routes to refund review", () => {
    expect(canTransition("PROCESSING", "BUDGET_EXCEEDED")).toBe(true);
    expect(canTransition("BUDGET_EXCEEDED", "REFUND_REVIEW")).toBe(true);
  });
});
