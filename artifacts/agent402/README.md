# Agent402

An x402-native AI fact-verification service. Clients pay a micro-payment in testnet USDC to verify a factual claim; the server settles on Base Sepolia and returns the result with a transaction hash.

## Running locally

```bash
pnpm --filter @workspace/agent402 run dev
```

The server starts on the port specified by the PORT environment variable (default: 5000).

---

## Smoke test

`scripts/smoke.ts` runs a full end-to-end payment flow against the live server:

1. Checks the `/api/v1/health` endpoint.
2. Confirms the server returns a `402` for an unauthenticated request.
3. Performs a real testnet x402 micro-payment via `@x402/fetch`.
4. Asserts the response is HTTP 200 with a `settlement.transactionHash`.

### Required environment variable

| Variable | Description |
|---|---|
| `PAYER_PRIVATE_KEY` | Private key of a Base Sepolia wallet that holds testnet USDC |

Set this value as a secure environment variable in your deployment environment. Do not commit secrets to the repository.

### Run manually

```bash
pnpm --filter @workspace/agent402 run smoke
```

The script exits **0** on success and **non-zero** on any failure, so it works cleanly in CI and scheduled workflows.

### Verify a specific server URL

```bash
AGENT402_URL=https://your-host/agent402 pnpm --filter @workspace/agent402 run smoke
```

---

## Scheduled smoke test

A scheduled smoke-test workflow can run the health and payment-path checks automatically.

### Check results

1. Configure the scheduled smoke test using your deployment platform or CI/CD scheduler.
2. Review the scheduler's run history and logs.
3. Scroll through the console output — each run is prefixed with a UTC timestamp and ends with `[RESULT] PASS` or `[RESULT] FAIL`.

### Change the interval

The wrapper script (`scripts/run-smoke-scheduled.sh`) reads `SMOKE_INTERVAL_SECONDS` from the environment. Configure it through your deployment platform’s secret/environment-variable management.

```bash
SMOKE_INTERVAL_SECONDS=3600 bash artifacts/agent402/scripts/run-smoke-scheduled.sh
```

### Re-run the smoke test immediately

Either run it manually with the command above, or restart the scheduled workflow — it runs the smoke test immediately on startup before sleeping.

---

## Project structure

```
artifacts/agent402/
├── src/
│   ├── index.ts          # Express app entry point
│   ├── routes/           # API route handlers
│   └── evals/            # LLM eval harness
├── scripts/
│   ├── smoke.ts                    # Smoke test script
│   └── run-smoke-scheduled.sh      # Scheduled runner (24-hour loop)
├── build.mjs             # esbuild config
└── package.json
```
