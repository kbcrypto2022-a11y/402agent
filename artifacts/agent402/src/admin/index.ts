/**
 * Admin dashboard — authenticated, server-rendered.
 *
 * Auth: ADMIN_PASSWORD env var (dashboard is disabled when unset) + an
 * HMAC-signed, expiring session cookie keyed by SESSION_SECRET. No secrets
 * are ever rendered or logged.
 *
 * Sections (per spec): TODAY, BY SERVICE, ACCURACY, OPERATIONS — plus
 * prominent alerts for loss-making and budget-exceeded transactions.
 * Test-mode transactions are always segmented from real (testnet) ones and
 * never mixed into the same totals.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import express from "express";
import type { Agent402Config } from "../config";
import type { TransactionRecord, TransactionStore } from "../database/types";
import { logger } from "../utils/logger";

const COOKIE_NAME = "agent402_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MIN_SESSION_SECRET_LENGTH = 16;

/**
 * Session-cookie signing key. No fallback: without a sufficiently strong
 * SESSION_SECRET the dashboard fails closed (a public default would let
 * anyone forge a valid session cookie).
 */
function sessionKey(): string | null {
  const secret = process.env["SESSION_SECRET"] ?? "";
  return secret.length >= MIN_SESSION_SECRET_LENGTH ? secret : null;
}

function sign(payload: string): string {
  const key = sessionKey();
  if (!key) throw new Error("SESSION_SECRET missing — admin sessions disabled");
  return createHmac("sha256", key).update(payload).digest("hex");
}

function issueSessionCookie(): string {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${sign(`admin.${exp}`)}`;
}

function validSession(cookieValue: string | undefined): boolean {
  if (!cookieValue || sessionKey() === null) return false;
  const [expStr, sig] = cookieValue.split(".");
  if (!expStr || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(`admin.${expStr}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Totals {
  requests: number;
  completed: number;
  revenue: number;
  cost: number;
  profit: number;
}

function emptyTotals(): Totals {
  return { requests: 0, completed: 0, revenue: 0, cost: 0, profit: 0 };
}

function addTx(t: Totals, tx: TransactionRecord): void {
  t.requests += 1;
  if (tx.status === "COMPLETED") t.completed += 1;
  t.revenue += tx.revenue;
  t.cost += tx.actualCost;
  t.profit += tx.grossProfit;
}

function marginOf(t: Totals): number | null {
  return t.revenue > 0 ? t.profit / t.revenue : null;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface DashboardData {
  byMode: Map<string, Totals>;
  byService: Map<string, Totals>;
  byAttribution: Map<string, Totals>;
  verdicts: Map<string, number>;
  verifyCount: number;
  confidenceSum: number;
  confidenceCount: number;
  latencySum: number;
  latencyCount: number;
  statusCounts: Map<string, number>;
  errorCounts: Map<string, number>;
  alerts: TransactionRecord[];
  recent: TransactionRecord[];
}

function aggregate(
  today: TransactionRecord[],
  recent: TransactionRecord[],
): DashboardData {
  const d: DashboardData = {
    byMode: new Map(),
    byService: new Map(),
    byAttribution: new Map(),
    verdicts: new Map(),
    verifyCount: 0,
    confidenceSum: 0,
    confidenceCount: 0,
    latencySum: 0,
    latencyCount: 0,
    statusCounts: new Map(),
    errorCounts: new Map(),
    alerts: [],
    recent,
  };
  for (const tx of today) {
    // Segment by payment mode — test transactions never mix with real ones.
    if (!d.byMode.has(tx.paymentMode)) d.byMode.set(tx.paymentMode, emptyTotals());
    addTx(d.byMode.get(tx.paymentMode)!, tx);
    if (!d.byService.has(tx.service)) d.byService.set(tx.service, emptyTotals());
    addTx(d.byService.get(tx.service)!, tx);
    const attribution = `${tx.requestSurface} / ${tx.clientLabel}`;
    if (!d.byAttribution.has(attribution)) {
      d.byAttribution.set(attribution, emptyTotals());
    }
    addTx(d.byAttribution.get(attribution)!, tx);

    d.statusCounts.set(tx.status, (d.statusCounts.get(tx.status) ?? 0) + 1);
    if (tx.errorCode) {
      d.errorCounts.set(tx.errorCode, (d.errorCounts.get(tx.errorCode) ?? 0) + 1);
    }
    if (tx.latencyMs !== null) {
      d.latencySum += tx.latencyMs;
      d.latencyCount += 1;
    }
    if (tx.confidenceScore !== null) {
      d.confidenceSum += tx.confidenceScore;
      d.confidenceCount += 1;
    }
    if (tx.service === "verify" && tx.status === "COMPLETED") {
      d.verifyCount += 1;
      const verdict =
        tx.result && typeof tx.result === "object"
          ? String((tx.result as Record<string, unknown>)["verdict"] ?? "UNKNOWN")
          : "UNKNOWN";
      d.verdicts.set(verdict, (d.verdicts.get(verdict) ?? 0) + 1);
    }
    if (
      tx.status === "BUDGET_EXCEEDED" ||
      (tx.status === "COMPLETED" && tx.grossProfit < 0) ||
      (tx.status === "FAILED" && tx.actualCost > 0)
    ) {
      d.alerts.push(tx);
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #0b0f14; color: #d6e2ef; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.4rem; letter-spacing: .05em; margin: 0 0 4px; color: #f2f7fc; }
  .sub { color: #7d93a8; font-size: .85rem; margin-bottom: 28px; }
  h2 { font-size: .8rem; letter-spacing: .14em; color: #8fb3d9; text-transform: uppercase; border-bottom: 1px solid #1d2a38; padding-bottom: 6px; margin: 36px 0 14px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .card { background: #101823; border: 1px solid #1d2a38; border-radius: 8px; padding: 14px 16px; }
  .card .k { font-size: .7rem; color: #7d93a8; letter-spacing: .08em; text-transform: uppercase; }
  .card .v { font-size: 1.25rem; margin-top: 6px; color: #f2f7fc; }
  .pos { color: #7fd1a8 !important; } .neg { color: #f08c8c !important; }
  table { width: 100%; border-collapse: collapse; font-size: .82rem; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #16202c; }
  th { color: #7d93a8; font-weight: 500; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
  .tag { display: inline-block; border-radius: 4px; padding: 1px 8px; font-size: .7rem; border: 1px solid #2b3a4a; }
  .tag.test { color: #e8c56a; border-color: #4a3f22; background: #201a0c; }
  .tag.testnet { color: #7fd1a8; border-color: #234a36; background: #0c2018; }
  .alert { background: #1f1012; border: 1px solid #55272c; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .alert b { color: #f08c8c; }
  .ok { color: #7fd1a8; }
  form { max-width: 340px; margin: 18vh auto; background: #101823; border: 1px solid #1d2a38; border-radius: 10px; padding: 28px; }
  input[type=password] { width: 100%; padding: 10px; background: #0b0f14; color: #d6e2ef; border: 1px solid #2b3a4a; border-radius: 6px; margin: 12px 0; }
  button { width: 100%; padding: 10px; background: #1d4ed8; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-family: inherit; }
  .muted { color: #7d93a8; }
`;

function loginPage(basePath: string, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Agent402 Admin</title><style>${STYLE}</style></head><body>
<form method="post" action="${basePath}/admin/login">
  <h1>Agent402 Admin</h1>
  <p class="sub">Operator access only.</p>
  ${error ? `<p style="color:#f08c8c">${esc(error)}</p>` : ""}
  <input type="password" name="password" placeholder="Admin password" autofocus required />
  <button type="submit">Sign in</button>
</form></body></html>`;
}

function totalsCards(t: Totals, label: string, mode: string): string {
  const m = marginOf(t);
  return `<h2>TODAY — ${esc(label)} <span class="tag ${esc(mode)}">${esc(mode)}</span></h2>
  <div class="cards">
    <div class="card"><div class="k">Requests</div><div class="v">${t.requests}</div></div>
    <div class="card"><div class="k">Completed</div><div class="v">${t.completed}</div></div>
    <div class="card"><div class="k">Revenue</div><div class="v">${usd(t.revenue)}</div></div>
    <div class="card"><div class="k">Costs</div><div class="v">${usd(t.cost)}</div></div>
    <div class="card"><div class="k">Gross profit</div><div class="v ${t.profit >= 0 ? "pos" : "neg"}">${usd(t.profit)}</div></div>
    <div class="card"><div class="k">Gross margin</div><div class="v ${m !== null && m < 0 ? "neg" : ""}">${pct(m)}</div></div>
  </div>`;
}

function dashboardPage(
  config: Agent402Config,
  d: DashboardData,
  basePath: string,
): string {
  const modes = [...d.byMode.entries()];
  const todaySections = modes.length
    ? modes
        .map(([mode, t]) =>
          totalsCards(
            t,
            mode === "test" ? "demo (no real money)" : "real testnet payments",
            mode,
          ),
        )
        .join("\n")
    : `<h2>TODAY</h2><p class="muted">No transactions yet today.</p>`;

  const alerts = d.alerts.length
    ? d.alerts
        .map(
          (tx) => `<div class="alert"><b>${esc(
            tx.status === "BUDGET_EXCEEDED" ? "BUDGET EXCEEDED" : "LOSS-MAKING",
          )}</b>
          — ${esc(tx.service)} ${esc(tx.id)} <span class="tag ${esc(tx.paymentMode)}">${esc(tx.paymentMode)}</span><br/>
          revenue ${usd(tx.revenue)} · cost ${usd(tx.actualCost)} · profit <span class="neg">${usd(tx.grossProfit)}</span>
          ${tx.errorCode ? ` · ${esc(tx.errorCode)}` : ""}</div>`,
        )
        .join("\n")
    : `<p class="ok">No loss-making or budget-exceeded transactions today.</p>`;

  const services = [...d.byService.entries()]
    .map(([svc, t]) => {
      const m = marginOf(t);
      return `<tr><td>${esc(svc.toUpperCase())}</td><td>${t.requests}</td><td>${t.completed}</td>
      <td>${usd(t.revenue)}</td><td>${usd(t.cost)}</td>
      <td class="${t.profit >= 0 ? "pos" : "neg"}">${usd(t.profit)}</td><td>${pct(m)}</td></tr>`;
    })
    .join("\n");
  const attributionRows = [...d.byAttribution.entries()]
    .map(([source, t]) => {
      return `<tr><td>${esc(source)}</td><td>${t.requests}</td><td>${t.completed}</td><td>${usd(
        t.revenue,
      )}</td></tr>`;
    })
    .join("\n");

  const verdictRows = [...d.verdicts.entries()]
    .map(
      ([v, n]) =>
        `<tr><td>${esc(v)}</td><td>${n}</td><td>${pct(d.verifyCount ? n / d.verifyCount : null)}</td></tr>`,
    )
    .join("\n");
  const insufficient = d.verdicts.get("INSUFFICIENT_EVIDENCE") ?? 0;
  const conflicting = d.verdicts.get("CONFLICTING_EVIDENCE") ?? 0;

  const statusRows = [...d.statusCounts.entries()]
    .map(([s, n]) => `<tr><td>${esc(s)}</td><td>${n}</td></tr>`)
    .join("\n");
  const errorRows = [...d.errorCounts.entries()]
    .map(([c, n]) => `<tr><td>${esc(c)}</td><td>${n}</td></tr>`)
    .join("\n");

  const recentRows = d.recent
    .slice(0, 30)
    .map(
      (tx) => `<tr>
      <td class="muted">${esc(tx.createdAt.toISOString().slice(5, 19).replace("T", " "))}</td>
      <td>${esc(tx.service)}</td>
      <td><span class="tag ${esc(tx.paymentMode)}">${esc(tx.paymentMode)}</span></td>
      <td>${esc(tx.status)}</td>
      <td>${usd(tx.revenue)}</td><td>${usd(tx.actualCost)}</td>
      <td class="${tx.grossProfit >= 0 ? "pos" : "neg"}">${usd(tx.grossProfit)}</td>
      <td>${tx.grossMargin !== null ? pct(tx.grossMargin) : "—"}</td>
      <td class="muted">${tx.confidenceScore !== null ? tx.confidenceScore.toFixed(2) : "—"}</td>
      <td class="muted">${tx.sourceCount !== null ? tx.sourceCount : "—"}</td>
      <td class="muted">${tx.settlementTx ? esc(tx.settlementTx.slice(0, 14)) + "…" : "—"}</td>
    </tr>`,
    )
    .join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Agent402 Admin</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>AGENT402 OPERATIONS</h1>
<p class="sub">Payment mode: <span class="tag ${esc(config.paymentMode)}">${esc(config.paymentMode)}</span>
 · network ${esc(config.paymentNetwork)} · ${esc(new Date().toUTCString())}
 · <a href="${basePath}/admin/logout" style="color:#8fb3d9">sign out</a></p>

<h2>ALERTS</h2>
${alerts}

${todaySections}

<h2>BY SERVICE (today)</h2>
<table><tr><th>Service</th><th>Requests</th><th>Completed</th><th>Revenue</th><th>Cost</th><th>Profit</th><th>Margin</th></tr>
${services || `<tr><td colspan="7" class="muted">No data</td></tr>`}</table>

<h2>PRIVACY-PRESERVING ATTRIBUTION (today)</h2>
<p class="muted">Aggregate public API usage by route surface and optional integration label. No IP addresses, user agents, cookies, wallet data, or identities are stored for this view.</p>
<table><tr><th>Surface / client</th><th>Requests</th><th>Completed</th><th>Revenue</th></tr>
${attributionRows || `<tr><td colspan="4" class="muted">No paid API requests yet today.</td></tr>`}</table>

<h2>ACCURACY (today)</h2>
<div class="cards">
  <div class="card"><div class="k">Avg confidence</div><div class="v">${
    d.confidenceCount ? (d.confidenceSum / d.confidenceCount).toFixed(2) : "—"
  }</div></div>
  <div class="card"><div class="k">Insufficient-evidence rate</div><div class="v">${pct(
    d.verifyCount ? insufficient / d.verifyCount : null,
  )}</div></div>
  <div class="card"><div class="k">Conflicting-evidence rate</div><div class="v">${pct(
    d.verifyCount ? conflicting / d.verifyCount : null,
  )}</div></div>
</div>
<table style="margin-top:12px"><tr><th>Verdict</th><th>Count</th><th>Share</th></tr>
${verdictRows || `<tr><td colspan="3" class="muted">No VERIFY transactions today</td></tr>`}</table>

<h2>OPERATIONS (today)</h2>
<div class="cards">
  <div class="card"><div class="k">Avg latency</div><div class="v">${
    d.latencyCount ? `${Math.round(d.latencySum / d.latencyCount)} ms` : "—"
  }</div></div>
  <div class="card"><div class="k">Budget-exceeded</div><div class="v ${
    (d.statusCounts.get("BUDGET_EXCEEDED") ?? 0) > 0 ? "neg" : ""
  }">${d.statusCounts.get("BUDGET_EXCEEDED") ?? 0}</div></div>
  <div class="card"><div class="k">Failed</div><div class="v">${d.statusCounts.get("FAILED") ?? 0}</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:12px">
<table><tr><th>Status</th><th>Count</th></tr>${statusRows || `<tr><td colspan="2" class="muted">No data</td></tr>`}</table>
<table><tr><th>Error code</th><th>Count</th></tr>${errorRows || `<tr><td colspan="2" class="muted">No errors</td></tr>`}</table>
</div>

<h2>RECENT TRANSACTIONS</h2>
<table><tr><th>Time (UTC)</th><th>Service</th><th>Mode</th><th>Status</th><th>Revenue</th><th>Cost</th><th>Profit</th><th>Margin</th><th>Confidence</th><th>Sources</th><th>Settlement</th></tr>
${recentRows || `<tr><td colspan="8" class="muted">No transactions</td></tr>`}</table>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAdminRouter(
  config: Agent402Config,
  store: TransactionStore,
  basePath: string,
): Router {
  const router = Router();
  const adminPassword = process.env["ADMIN_PASSWORD"] ?? "";

  // Fail closed: the dashboard only activates when BOTH the password and a
  // strong session-signing secret exist. Read at request time so tests and
  // late-provisioned secrets behave predictably.
  const disabledReason = (): string | null => {
    if (!adminPassword) return "ADMIN_PASSWORD";
    if (sessionKey() === null) return "SESSION_SECRET (min 16 chars)";
    return null;
  };
  const sendDisabled = (res: Response, missing: string): void => {
    res
      .status(503)
      .type("html")
      .send(
        `<!doctype html><body style="font-family:monospace;background:#0b0f14;color:#d6e2ef;padding:40px">
         <h2>Admin dashboard disabled</h2>
         <p>Set the <code>${missing}</code> environment secret to enable it.</p></body>`,
      );
  };

  router.get("/admin", async (req: Request, res: Response, next) => {
    try {
      const missing = disabledReason();
      if (missing) {
        sendDisabled(res, missing);
        return;
      }
      if (!validSession(readCookie(req, COOKIE_NAME))) {
        res.status(401).type("html").send(loginPage(basePath));
        return;
      }
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const [today, recent] = await Promise.all([
        store.listSince(startOfDay, 2000),
        store.list(30),
      ]);
      res.type("html").send(dashboardPage(config, aggregate(today, recent), basePath));
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/admin/login",
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req: Request, res: Response) => {
      const missing = disabledReason();
      if (missing) {
        sendDisabled(res, missing);
        return;
      }
      const supplied = String((req.body as Record<string, unknown>)?.["password"] ?? "");
      const a = Buffer.from(supplied);
      const b = Buffer.from(adminPassword);
      const ok =
        adminPassword.length > 0 &&
        a.length === b.length &&
        timingSafeEqual(a, b);
      if (!ok) {
        logger.warn("admin login failed");
        res.status(401).type("html").send(loginPage(basePath, "Incorrect password."));
        return;
      }
      res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${issueSessionCookie()}; Path=${basePath}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
      );
      res.redirect(`${basePath}/admin`);
    },
  );

  router.get("/admin/logout", (_req: Request, res: Response) => {
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=; Path=${basePath}; HttpOnly; Max-Age=0`,
    );
    res.redirect(`${basePath}/admin`);
  });

  return router;
}
