# 402Agent

402Agent is an x402-native AI fact-verification API. Clients request a verification, pay a testnet USDC micro-payment on Base Sepolia, and receive a structured result with settlement details.

## What is included

- Paid x402 VERIFY, SEARCH, and READ API services
- Server-rendered developer website and live API documentation
- Machine-readable discovery at `GET /.well-known/x402` and `GET /openapi.json`
- Base Sepolia testnet payment support via the standard x402 facilitator and Coinbase CDP
- PostgreSQL-backed transaction ledger with an in-memory development fallback
- Unit and regression tests (252 tests across 15 suites) and a testnet smoke-test script

## Requirements

- Node.js 24
- pnpm 10
- PostgreSQL (optional for local development — service falls back to an in-memory store)

## Quickstart

```bash
git clone https://github.com/kbcrypto2022-a11y/402agent.git
cd 402agent
pnpm install --frozen-lockfile
pnpm --filter @workspace/agent402 run dev
```

The service starts on `PORT` (default `8090`). The homepage and docs are served at `/agent402`.

## Environment variables

Configure these through your hosting platform's secret manager — do not put them in `.env` files committed to this repository.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Optional | PostgreSQL connection string; falls back to in-memory store if absent |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Yes (production) | OpenAI API key for AI inference |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Optional | Override the OpenAI-compatible base URL |
| `CDP_API_KEY_ID` | Yes (CDP payment path) | Coinbase CDP API key ID |
| `CDP_API_KEY_SECRET` | Yes (CDP payment path) | Coinbase CDP API key secret |
| `PAYER_PRIVATE_KEY` | Smoke test only | Funded testnet wallet private key for the smoke-test client |
| `ADMIN_PASSWORD` | Optional | Enables the `/agent402/admin` dashboard |
| `SESSION_SECRET` | Optional | Signs the admin session cookie (auto-generated if absent) |

## Validate the release

```bash
# Type-check
pnpm run typecheck

# Full test suite
pnpm --filter @workspace/agent402 run test

# End-to-end testnet smoke test (requires PAYER_PRIVATE_KEY)
pnpm --filter @workspace/agent402 run smoke
```

## Machine discovery

402Agent publishes two machine-readable discovery documents:

- `GET /.well-known/x402` — x402 service manifest (payment surfaces, methods, resources, prices)
- `GET /openapi.json` — OpenAPI 3.1 specification

## Project layout

```
artifacts/agent402/     API service, website, payment logic, and tests
  src/accuracy/         Confidence scoring and result corroboration
  src/admin/            Optional password-protected admin dashboard
  src/api/              Request routing, OpenAPI spec, website rendering
  src/costs/            Cost ledger and margin tracking
  src/database/         Drizzle-backed store and in-memory fallback
  src/monitoring/       CDP Bazaar discovery monitor
  src/payments/x402/    Standard x402 and CDP payment processors
  src/pricing/          Budget engine and per-service price tiers
  src/providers/        OpenAI provider adapter
  src/security/         Rate limiting and SSRF guard
  src/services/         VERIFY, SEARCH, and READ fulfilment logic
  src/tests/            All unit and regression tests
  src/utils/            Logger, HTML renderer, money helpers
  scripts/              Smoke-test, monitoring, and startup scripts
lib/db/                 Shared Drizzle schema (@workspace/db)
attached_assets/        Public 402Agent logo assets
```

See [`artifacts/agent402/README.md`](artifacts/agent402/README.md) for detailed endpoint documentation and smoke-test usage.

## Security notes

- Do not commit private keys, `.env` files, database exports, or call logs.
- The `.gitignore` in this repository intentionally excludes all of the above.
- `PAYER_PRIVATE_KEY` is used only by the testnet smoke-test client and must never be sent to the API.
