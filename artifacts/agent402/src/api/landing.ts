/**
 * Agent402 landing page. Brand language per spec:
 * SEARCH. READ. VERIFY. / High-accuracy intelligence for AI agents /
 * Agents for agents / Pay only for what your agent uses.
 * Design: precise, technical, calm — no crypto-hype, no exaggerated claims.
 */

import type { Agent402Config } from "../config";
import { presentationStyles, siteNav, statusPill } from "./presentation";

export function landingPageHtml(
  basePath: string,
  config?: Agent402Config,
): string {
  const mode = config?.paymentMode ?? "test";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
 <style>${presentationStyles}</style>
</head>
<body>
 ${siteNav(basePath)}
 <main>
 <header class="hero"><div class="wrap"><div class="hero-grid"><div>
   ${statusPill(mode)}
   <h1>Your agent can buy the <em>intelligence</em> it needs.</h1>
   <p class="lede">Structured web intelligence, paid for per request over x402. No accounts. No API keys. No subscriptions. The machine gets a quote, pays, and receives evidence-backed JSON.</p>
   <div class="hero-actions"><a class="button primary" href="${basePath}/docs">Open the quickstart</a><a class="button" href="${basePath}/api/v1/services">View service metadata ↗</a></div>
 </div><div><div class="hero-note"><strong>Intelligence for agents.</strong>Discovery, retrieval, and verification as composable protocol primitives. Built for systems that need to know where an answer came from.</div>
   <div class="trace"><span class="dim">$ agent.request</span><br/>→ POST /api/v1/verify<br/><b>← 402 Payment Required</b><br/>→ PAYMENT-SIGNATURE: [signed]<br/><b>← 200 OK · result + evidence</b></div>
 </div></div></div></header>

 <section class="section" id="services"><div class="wrap">
   <div class="section-head"><h2>01 / service catalog</h2><p class="section-intro">Three focused operations. Each one returns structured output and carries its sources forward.</p></div>
   <div class="services">
    <div class="svc">
       <span class="svc-index">01 / DISCOVERY</span><h3>SEARCH</h3><p>Find current, relevant results for a query — ranked, deduplicated, and tiered by source quality.</p><div class="svc-end">POST ${basePath}/api/v1/search</div>
    </div>
    <div class="svc">
       <span class="svc-index">02 / EXTRACTION</span><h3>READ</h3><p>Extract the signal from a URL. Title, summary, key points, and stated facts kept separate from inference.</p><div class="svc-end">POST ${basePath}/api/v1/read</div>
    </div>
    <div class="svc">
       <span class="svc-index">03 / EVIDENCE</span><h3>VERIFY</h3><p>Evidence-weighed verdicts that admit uncertainty: verified, not verified, insufficient, or conflicting.</p><div class="svc-end">POST ${basePath}/api/v1/verify</div>
    </div>
  </div>
</div></section>

 <section class="section" id="protocol"><div class="wrap"><div class="split">
  <div>
     <div class="section-head"><h2>02 / x402 protocol</h2></div><ol class="steps"><li><span>01</span><div><strong>Request</strong>Call a service endpoint with JSON.</div></li><li><span>02</span><div><strong>Quote</strong>Receive HTTP 402 with exact requirements.</div></li><li><span>03</span><div><strong>Authorize</strong>Sign the USDC payment and retry the same request.</div></li><li><span>04</span><div><strong>Deliver</strong>Work completes; settlement follows a successful result.</div></li></ol>
     <p class="section-intro">Live pricing is served at <a href="${basePath}/api/v1/pricing">GET /api/v1/pricing</a>. Amounts and network are never guessed by the client.</p>
  </div>
  <div>
     <div class="panel"><div class="panel-label">payment envelope / illustrative shape</div><pre class="json">{<br/>  <span class="key">"status"</span>: <span class="value">402</span>,<br/>  <span class="key">"protocol"</span>: <span class="value">"x402"</span>,<br/>  <span class="key">"requirements"</span>: <span class="value">"served live"</span>,<br/>  <span class="key">"transaction_id"</span>: <span class="value">"issued per request"</span><br/>}</pre></div>
  </div>
</div></div></section>

 <section class="section" id="trust"><div class="wrap"><div class="split"><div><div class="section-head"><h2>03 / trust surface</h2></div><p class="section-intro">Evidence is part of the response, not a footnote. The service exposes uncertainty instead of filling gaps with confidence.</p></div><div class="panel"><div class="panel-label">service status</div><div class="status-row"><span>Health endpoint</span><span class="status-value">AVAILABLE</span></div><div class="status-row"><span>Payment mode</span><span class="status-value">${mode === "testnet" ? "TESTNET" : "DEMO"}</span></div><div class="status-row"><span>Production settlement</span><span class="status-value unavailable">UNAVAILABLE</span></div><div class="status-row"><span>Live activity feed</span><span class="status-value unavailable">UNAVAILABLE</span></div></div></div></div></section>
 <section class="section"><div class="wrap"><div class="section-head"><h2>04 / build with it</h2><p class="section-intro">Start with a free quote. The full request contract, payment flow, OpenAPI spec, and example client live in the docs.</p></div><div class="trace"><span class="dim">$ curl -X POST</span> ${basePath}/api/v1/verify \\<br/>  -H "Content-Type: application/json" \\<br/>  -d '{"claim":"..."}'<br/><b>← 402 Payment Required · exact requirements + transaction_id</b></div><div class="hero-actions"><a class="button primary" href="${basePath}/docs">Read developer docs</a><a class="button" href="${basePath}/openapi.json">OpenAPI JSON ↗</a></div></div></section>
 </main>

 <footer class="wrap"><span>402Agent.ai · Intelligence for agents.</span><span><a href="${basePath}/api/v1/health">status</a> · <a href="${basePath}/api/v1/services">service metadata</a> · <a href="${basePath}/docs">docs</a></span></footer>
</body>
</html>`;
}
