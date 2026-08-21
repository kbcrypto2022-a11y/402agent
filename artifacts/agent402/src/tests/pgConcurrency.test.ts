/**
 * Postgres integration tests: atomic payment claim under concurrent retries.
 * Skipped automatically when DATABASE_URL is not available.
 */
import { describe, expect, it, afterAll } from "vitest";
import { handleServiceRequest } from "../api/flow";
import { issueTestPayment } from "../payments/x402/mock";
import { MockPaymentProcessor } from "../payments/x402/mockProcessor";
import type { TransactionRecord } from "../database/types";
import type { VerifiedPaymentInfo } from "../payments/x402/processor";
import { testConfig } from "./pricing.test";

const processor = new MockPaymentProcessor(testConfig());

const hasDb = Boolean(process.env["DATABASE_URL"]);

describe.skipIf(!hasDb)("Postgres store: concurrent payment retries", () => {
  it("only one of two concurrent paid retries performs the work", async () => {
    const { PgTransactionStore } = await import("../database/pgStore");
    const { ensureSchema } = await import("../database/provision");
    await ensureSchema();
    const store = new PgTransactionStore();
    const config = testConfig();
    const body = { claim: `concurrency test ${Date.now()}` };

    const quoted = await handleServiceRequest({
      config,
      store,
      processor,
      service: "verify",
      body,
    });
    if (quoted.kind !== "payment_required") throw new Error("expected 402");
    const tx = (await store.get(quoted.transactionId))!;
    const payment = issueTestPayment(config, tx.id, tx.quotedPrice);

    const attempt = () =>
      handleServiceRequest({
        config,
        store,
        processor,
        service: "verify",
        body,
        paymentHeader: payment.header,
      });
    const [a, b] = await Promise.all([attempt(), attempt()]);

    const outcomes = [a, b];
    const freshCompletions = outcomes.filter(
      (o) => o.kind === "completed" && !o.replayed,
    );
    // Exactly one retry may do the paid work.
    expect(freshCompletions).toHaveLength(1);
    for (const o of outcomes) {
      expect(["completed", "error"]).toContain(o.kind);
      if (o.kind === "error") {
        expect([409, 402]).toContain(o.statusCode);
      }
    }

    const after = (await store.get(tx.id))!;
    expect(after.status).toBe("COMPLETED");
    expect(after.paymentReference).toBe(payment.reference);
    // Costs recorded exactly once (single verify pipeline: 0.004+0.002+0.01).
    expect(after.actualCost).toBeCloseTo(0.016, 9);
    expect(after.revenue).toBeCloseTo(after.quotedPrice, 9);
  });

  it("a consumed payment reference cannot be claimed by another transaction", async () => {
    const { PgTransactionStore } = await import("../database/pgStore");
    const store = new PgTransactionStore();
    const config = testConfig();
    const body = { query: `ref reuse ${Date.now()}` };

    const q1 = await handleServiceRequest({ config, store, processor, service: "search", body });
    const q2 = await handleServiceRequest({ config, store, processor, service: "search", body });
    if (q1.kind !== "payment_required" || q2.kind !== "payment_required") {
      throw new Error("expected 402s");
    }
    const tx1 = (await store.get(q1.transactionId))!;
    const payment = issueTestPayment(config, tx1.id, tx1.quotedPrice);

    const done = await handleServiceRequest({
      config,
      store,
      processor,
      service: "search",
      body,
      paymentHeader: payment.header,
    });
    expect(done.kind).toBe("completed");

    // Same reference against the second transaction must fail the claim.
    const stolen = await store.claimForProcessing(q2.transactionId, {
      paymentReference: payment.reference,
      revenue: tx1.quotedPrice,
    });
    expect(stolen).toBeNull();
  });

  it("two payments sharing an EIP-3009 nonce: exactly one settles", async () => {
    const { PgTransactionStore } = await import("../database/pgStore");
    const { ensureSchema } = await import("../database/provision");
    await ensureSchema();
    const store = new PgTransactionStore();
    const config = testConfig();

    // Shared composite nonce key — mirrors the real extractAuthorizationNonce
    // output format: {network}:{from}:{nonce}.  Two different outer signatures
    // (different paymentReference values) share this key, simulating a client
    // that re-signs the same EIP-3009 authorization with a fresh envelope.
    const sharedNonce = `eip155:84532:0xpayer${Date.now().toString(16)}:0x${"ab".repeat(32)}`;

    // Processor that layers a fixed EIP-3009 authorization nonce on top of
    // the standard mock verification, without touching the payment token itself
    // (which stays unique per transaction so locateTransaction still works).
    class SharedNonceProcessor extends MockPaymentProcessor {
      override async verify(
        header: string,
        tx: TransactionRecord,
      ): Promise<VerifiedPaymentInfo> {
        const base = await super.verify(header, tx);
        return { ...base, authorizationNonce: sharedNonce };
      }
    }
    const nonceProc = new SharedNonceProcessor(config);

    // Two separate quote requests — different bodies → different transaction rows.
    const bodyA = { claim: `nonce-guard-A ${Date.now()}` };
    const bodyB = { claim: `nonce-guard-B ${Date.now()}` };

    const qA = await handleServiceRequest({
      config,
      store,
      processor: nonceProc,
      service: "verify",
      body: bodyA,
    });
    const qB = await handleServiceRequest({
      config,
      store,
      processor: nonceProc,
      service: "verify",
      body: bodyB,
    });
    if (qA.kind !== "payment_required" || qB.kind !== "payment_required") {
      throw new Error("expected 402s for both quotes");
    }

    const txA = (await store.get(qA.transactionId))!;
    const txB = (await store.get(qB.transactionId))!;

    // Different outer payment tokens → different paymentReference values, but
    // both resolve to sharedNonce after verify().
    const payA = issueTestPayment(config, txA.id, txA.quotedPrice);
    const payB = issueTestPayment(config, txB.id, txB.quotedPrice);

    // Fire both concurrently; the UNIQUE constraint on authorization_nonce must
    // allow exactly one claimForProcessing to win.
    const [rA, rB] = await Promise.all([
      handleServiceRequest({
        config,
        store,
        processor: nonceProc,
        service: "verify",
        body: bodyA,
        paymentHeader: payA.header,
      }),
      handleServiceRequest({
        config,
        store,
        processor: nonceProc,
        service: "verify",
        body: bodyB,
        paymentHeader: payB.header,
      }),
    ]);

    const outcomes = [rA, rB];

    // Exactly one fresh settlement must succeed.
    const freshSettlements = outcomes.filter(
      (o) => o.kind === "completed" && !o.replayed,
    );
    expect(freshSettlements).toHaveLength(1);

    // The losing outcome must be a conflict (409) or payment error (402).
    for (const o of outcomes) {
      expect(["completed", "error"]).toContain(o.kind);
      if (o.kind === "error") {
        expect([409, 402]).toContain(o.statusCode);
      }
    }

    // Confirm the DB: exactly one of the two rows reached COMPLETED status.
    const [afterA, afterB] = await Promise.all([
      store.get(txA.id),
      store.get(txB.id),
    ]);
    const completedCount = [afterA, afterB].filter(
      (r) => r?.status === "COMPLETED",
    ).length;
    // This is the facilitator-settle-count equivalent in mock mode:
    // the nonce guard must allow at most one settlement.
    expect(completedCount).toBe(1);
  });

  it("a replayed nonce is rejected while the first settlement is still in-flight", async () => {
    const { PgTransactionStore } = await import("../database/pgStore");
    const { ensureSchema } = await import("../database/provision");
    await ensureSchema();
    const store = new PgTransactionStore();
    const config = testConfig();

    const sharedNonce = `eip155:84532:0xinflight${Date.now().toString(16)}:0x${"cd".repeat(32)}`;

    class SharedNonceProcessor extends MockPaymentProcessor {
      override async verify(
        header: string,
        tx: TransactionRecord,
      ): Promise<VerifiedPaymentInfo> {
        const base = await super.verify(header, tx);
        return { ...base, authorizationNonce: sharedNonce };
      }
    }
    const nonceProc = new SharedNonceProcessor(config);

    const bodyA = { claim: `inflight-nonce-A ${Date.now()}` };
    const bodyB = { claim: `inflight-nonce-B ${Date.now()}` };

    const qA = await handleServiceRequest({
      config,
      store,
      processor: nonceProc,
      service: "verify",
      body: bodyA,
    });
    if (qA.kind !== "payment_required") throw new Error("expected 402 for A");
    const txA = (await store.get(qA.transactionId))!;
    const payA = issueTestPayment(config, txA.id, txA.quotedPrice);

    // Fulfiller for A that blocks until we explicitly release it, holding
    // transaction A in PROCESSING (claimed, nonce recorded, not COMPLETED).
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aClaimed!: () => void;
    const aInFlight = new Promise<void>((resolve) => {
      aClaimed = resolve;
    });
    const blockedFulfiller = async () => {
      aClaimed(); // A has passed claimForProcessing and is now mid-flight.
      await gateA;
      return { confidence: 0.9, source_count: 1, verdict: "ok" };
    };

    const firstSettlement = handleServiceRequest({
      config,
      store,
      processor: nonceProc,
      service: "verify",
      body: bodyA,
      paymentHeader: payA.header,
      fulfiller: blockedFulfiller,
    });

    // Wait until A holds the claim (status PROCESSING, nonce recorded).
    await aInFlight;
    const midFlightA = (await store.get(txA.id))!;
    expect(midFlightA.status).toBe("PROCESSING");
    expect(midFlightA.authorizationNonce).toBe(sharedNonce);

    // Now a fresh quote B (PAYMENT_REQUIRED) is paid with a *different*
    // payment token that resolves to the SAME EIP-3009 nonce. The
    // claimForProcessing WHERE clause alone (status = PAYMENT_REQUIRED)
    // would let this through — the UNIQUE constraint on authorization_nonce
    // must reject it even though A has not reached COMPLETED yet.
    const qB = await handleServiceRequest({
      config,
      store,
      processor: nonceProc,
      service: "verify",
      body: bodyB,
    });
    if (qB.kind !== "payment_required") throw new Error("expected 402 for B");
    const txB = (await store.get(qB.transactionId))!;
    const payB = issueTestPayment(config, txB.id, txB.quotedPrice);

    // Direct store-level assertion: the claim must be a null (lost) claim.
    const stolen = await store.claimForProcessing(txB.id, {
      paymentReference: payB.reference,
      revenue: txB.quotedPrice,
      authorizationNonce: sharedNonce,
    });
    expect(stolen).toBeNull();

    // Full-flow assertion: the request is rejected, never completed.
    const replayOutcome = await handleServiceRequest({
      config,
      store,
      processor: nonceProc,
      service: "verify",
      body: bodyB,
      paymentHeader: payB.header,
    });
    expect(replayOutcome.kind).toBe("error");
    if (replayOutcome.kind === "error") {
      expect([409, 402]).toContain(replayOutcome.statusCode);
    }

    // B must still be un-settled.
    const afterB = (await store.get(txB.id))!;
    expect(afterB.status).not.toBe("COMPLETED");
    expect(afterB.paymentReference).toBeNull();

    // Release A: the original settlement completes normally.
    releaseA();
    const rA = await firstSettlement;
    expect(rA.kind).toBe("completed");
    if (rA.kind === "completed") expect(rA.replayed).toBe(false);
    const afterA = (await store.get(txA.id))!;
    expect(afterA.status).toBe("COMPLETED");
    expect(afterA.authorizationNonce).toBe(sharedNonce);
  });

  afterAll(async () => {
    // Leave test rows in place (clearly labeled paymentMode=test).
  });
});
