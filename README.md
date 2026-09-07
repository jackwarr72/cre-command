# cre-command

**Commercial Real Estate intelligence, crawling & lead-generation control panel** — built on the **Kinetic Noir** design system (dark-mode-first, gold `#FFCC00` accents, Inter typography).

## What it does

Crawls public CRE listing sources, normalizes them into one canonical schema, detects changes and duplicates over time, and exposes everything through an operational control panel:

```
Configure Sources → Define Search → Crawl → Extract → Normalize →
Deduplicate → Store → Review → Export → Feed Sales/CRM
```

Compliance-first crawling: explicit per-source policy gate (fail closed), robots.txt handling (RFC 9309 subset), per-source rate limits, bounded requests, honest User-Agent, and **no** CAPTCHA/anti-bot/authentication/paywall bypass.

## Monorepo layout

| Package | Purpose |
|---|---|
| `apps/web` | Next.js control panel (Kinetic Noir UI) |
| `packages/api` | Fastify REST API — auth, sources, crawl runs, listings |
| `packages/crawler` | Crawl engine — policy → robots → HTTP → adapter → dedup → persist |
| `packages/adapters` | Per-source parsers (Vivanuncios; extensible) |
| `packages/db` | Drizzle schema + Postgres client |
| `packages/shared` | Cross-layer domain types & zod schemas |
| `packages/workers` | Reserved for out-of-process crawl scheduling |

## Getting started

```bash
npm install

# Postgres (defaults to postgres://cre:secret@localhost:5432/cre_command)
$env:DATABASE_URL = 'postgres://user:pass@localhost:5432/cre_command'

# Bootstrap admin (only when the users table is empty)
$env:CRE_ADMIN_EMAIL = 'admin@example.com'
$env:CRE_ADMIN_PASSWORD = 'change-me'

npm run dev          # web (3000) + api (4000) together
npm run typecheck    # all 7 projects, strict
npm test             # vitest suites
npm run build:web    # production web build
```

Then open **http://localhost:3000** and sign in with the bootstrap credentials.

## Verification status

- `npm run typecheck` — clean across `shared`, `db`, `adapters`, `crawler`, `api`, `workers`, `web`.
- `npm test` — **125 passed** (8 skipped: live-Postgres integration).
- `npm run build:web` — production build.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architecture, API spec, crawler pipeline, and roadmap.
