# cre-command — Architecture Overview

**Commercial Real Estate intelligence, crawling & lead-generation platform** (Kinetic Noir design system).

This document is the authoritative technical reference for the system.

---

## 1. Executive Overview

cre-command is a monorepo platform that crawls public commercial-real-estate
sources, normalizes heterogeneous listings into one canonical schema, detects
change/duplicates over time, and exposes everything through an operational
control panel. The crawler is the first subsystem; CRM modules (contacts,
opportunities, tasks, SLA, funnel) evolve around the same normalized data
model without rewriting the crawler.

Core workflow:

```
Configure Sources → Define Search → Crawl → Extract → Normalize →
Deduplicate → Store → Review → Export → Feed Sales/CRM
```

## 2. Technology Stack & Rationale

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) | One language across all layers; compile-time safety |
| Monorepo | npm workspaces | Simple, no extra tooling; packages/ + apps/ |
| Frontend | Next.js 15 + React 19 + Tailwind 3 + SWR | App Router, fast DX; SWR for polling crawl progress |
| API | Fastify + Zod | Fast, schema-first, excellent TS ergonomics |
| DB | PostgreSQL via Drizzle ORM | Typed schema, migrations, relational integrity |
| Crawling | Node fetch + cheerio adapters | No browser needed for list pages; honest UA |
| Tests | Vitest | Workspace-native, fast, TS-first |
| Auth | Opaque bearer sessions, bcrypt hashes | Simple, revocable, no JWT revocation problem |

## 3. System Architecture

```
┌────────────┐   rewrites /api/*   ┌─────────────┐
│  apps/web  │ ──────────────────▶ │ packages/api │ ──▶ PostgreSQL
│ (Next.js)  │                     │  (Fastify)   │
└────────────┘                     └──────┬───────┘
                                        │ crawl.trigger()
                                        ▼
                              ┌───────────────────┐
                              │ packages/crawler   │  policy gate → robots.txt →
                              │ (engine, in-proc)  │  rate-limited HTTP → adapter →
                              └───────┬───────────┘  normalize → dedup → persist
                                      │ uses
                                      ▼
                              ┌───────────────────┐
                              │ packages/adapters  │  one adapter per source
                              └───────────────────┘
```

- **apps/web** — Next.js control panel (Kinetic Noir). Proxies `/api/*` to the API (single origin, no CORS).
- **packages/api** — REST API. Repository ports (`AppDeps`) + Postgres implementations + test fakes. Bearer-token auth with role guards (`viewer < operator < admin`).
- **packages/crawler** — crawl engine. `Crawler.crawl(source, urls)` = policy gate → robots.txt → bounded HTTP → adapter parse → fingerprint/dedup → persist → observations.
- **packages/adapters** — per-source parsers. `SourceAdapter.canHandle(url)` + `parse(html)` → `ListingCandidate[]`. Adding a source = adding a folder; no engine changes.
- **packages/db** — Drizzle schema + row types.
- **packages/shared** — cross-layer domain types & zod schemas. Single source of truth for enums (`PROPERTY_TYPES`, `LISTING_STATUSES`, …) so DB enums and API contracts can never drift.
- **packages/workers** — reserved for out-of-process crawl scheduling; the engine is currently triggered in-process per run.

## 4. Database Schema (ERD summary)

```
sources ─┬─< crawl_runs
         └─< listings ─< listing_observations
users ─< sessions
contacts
```

- **sources** — key (adapter key), name, baseUrl, enabled, schedule (cron),
  config (jsonb), plus the compliance policy: `crawl_allowed`, `robots_policy`
  (`strict|honor|allow`), `rate_limit_ms`, `max_workers`,
  `authentication_required` (fail-closed).
- **listings** — canonical row: source FK, external id, source URL, title,
  description, property/listing type, address fields, geo, price
  (amount/currency/unit), size, listedAt, status + provenance
  (first/last seen, fingerprint).
- **listing_observations** — append-only raw record of every crawl that saw
  the listing (price, snapshot payload, seen_at, run id). This is the audit
  trail that answers "what was the previous price?" and "when did it change?".
- **crawl_runs** — execution record per source run: status
  (`queued|running|completed|completed_with_errors|failed|cancelled`), counts
  (found/added/updated), structured errors array.
- **users / sessions** — operator accounts, bcrypt hashes, hashed bearer tokens.

Indexes cover source, city, property/listing type, price, status, discovery
and last-seen timestamps.

## 5. Crawler Architecture

Pipeline per run (`packages/crawler/src/crawl.ts`):

1. **Policy gate** (`policy.ts`) — configuration check, fail closed:
   unknown source / disabled / `crawl_allowed=false` / `authentication_required`
   ⇒ reject with a machine-readable reason. The crawler never authenticates
   implicitly and never bypasses CAPTCHAs, anti-bot, or paywalls.
2. **robots.txt** (`robots.ts`) — RFC 9309 subset. `allow` skips (operator-
   authorized feeds), `honor` obeys (missing file = allowed, indeterminate =
   denied), `strict` requires a parseable robots.txt that permits the path.
3. **HTTP transport** (`http.ts`) — honest User-Agent, per-attempt timeout,
   2 MiB bounded reads, bounded exponential-backoff retries for retryable
   failures only (timeout, 429 with Retry-After, 5xx).
4. **Rate limiting** (`rate-limit.ts`) — one interval limiter per source from
   `rate_limit_ms`; guarantees politeness across workers.
5. **Adapter parse** — source-specific; returns validated `ListingCandidate[]`
   + structured parse errors.
6. **Fingerprint/dedup** (`fingerprint.ts`) — SHA-256 over the materialized
   listing state (canonical numerics/dates) computed identically from
   candidates and rows; unchanged sources never mutate canonical rows.
7. **Persist** — upsert listing; append observation on every sight; update
   run counters (found/added/updated) and errors.
8. **Observability** — every failure lands in `crawl_runs.errors` with URL,
   retry count, and a `fatal` flag; statuses map to
   `completed_with_errors` / `failed`.

Concurrency: the API triggers runs per source; per-source `max_workers` and
rate limits bound parallelism, so 100+ configured targets are controlled by
policy, not by unrestricted parallel requests.

## 6. Deduplication & History

- Identity: (source, externalId) and canonical source URL.
- Change detection: SHA-256 fingerprint of materialized state — same function
  for incoming candidates and stored rows, so a no-op crawl writes nothing.
- History: `listing_observations` preserves each sighting (price, payload,
  timestamps, run). Price/status history and "when did it disappear" are
  answerable by diffing consecutive observations.

## 7. API Specification (v1)

Base: `/api`. Auth: `Authorization: Bearer <token>` (from `POST /auth/login`).
Errors: `{ "error": { "message", "code?" } }`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /auth/login | — | `{email,password}` → `{user,token,expiresAt}` |
| GET | /auth/me | user | current session user |
| POST | /auth/logout | user | revokes session |
| GET | /health | — | liveness |
| GET | /sources | user | list with policy fields |
| PATCH | /sources/:key | operator/admin | `enabled, crawlAllowed, robotsPolicy, rateLimitMs, maxWorkers` |
| GET | /crawl-runs | user | `?sourceKey&status&page&pageSize` |
| POST | /crawl-runs | operator/admin | `{sourceKey, urls?}` → run record (404/400 NO_ADAPTER/NO_URLS) |
| GET | /listings | user | filters: `q, propertyTypes, listingTypes, statuses, sourceKeys, states, cities, minPrice, maxPrice, updatedSince` (CSV arrays), `page,pageSize` |
| GET | /listings/:id | user | detail |

Validation is zod-first: unknown enum values are 400s, never silently dropped.

## 8. Frontend Information Architecture (Kinetic Noir)

Sidebar groups: Overview (Dashboard) · Operations (Crawler, Search Jobs,
Sources) · Data (Properties, Listings, Duplicates) · CRM (Contacts, Tasks,
Calendar, Opportunities) · Insights (Metrics, Audit) · System (Admin).

Design tokens (`apps/web/tailwind.config.js`):
- Surfaces: `noir-950…noir-700` tonal layering (no heavy shadows).
- Accent: `gold #FFCC00` — primary buttons, active nav, key metrics only.
- Semantics: `accent-success/warning/danger` at 15% fills with matching text.
- Typography: Inter; uppercase micro-labels with wide tracking.
- Components: `Button` (gold default = primary action), `Badge`, `Input`,
  `Select`, `Pagination`, `Spinner`, module placeholders for future CRM pages.

Screens: Dashboard (KPI cards + recent runs + latest listings), Crawler
(search console with RUN SEARCH), Search Jobs (run history + detail),
Sources (policy management), Listings (filterable data table + detail),
and placeholder-backed CRM/ops routes ready for Phase 4–5 buildout.

## 9. Security & Compliance

- bcrypt password hashes; opaque session tokens stored only as SHA-256.
- Role guards: `requireAuth` / `requireRole('operator','admin')` per route.
- Zod validation on every body/query; parameterized queries via Drizzle.
- Crawler compliance: explicit config gate (fail closed), robots.txt honored
  per policy, per-source rate limits, bounded requests, honest UA, no
  auth/CAPTCHA/anti-bot/paywall bypass. Data retention follows the
  observation model (drop observations ⇒ drop history).

## 10. Testing & Verification

- Unit/integration tests (Vitest) for crawler pipeline, adapters, API routes
  with in-memory fakes (`packages/api/test/fakes.ts`).
- `npm run typecheck` — all 7 projects strict-clean.
- External sources are never hit in tests; fixtures only.

## 11. Roadmap

- **Phase 1 (done):** auth, DB, base UI (Kinetic Noir), navigation, roles.
- **Phase 2 (done):** sources + policy, crawl runs, engine, adapters,
  normalization, fingerprint dedup.
- **Phase 3 (done):** listings DB, filters, detail views, run history.
- **Phase 4 (next):** metrics, audit log, manual capture, contacts CRUD,
  assignment, tasks, SLA monitor (<24h).
- **Phase 5:** calendar, funnel, opportunities, notifications.
- **Phase 6:** worker split (packages/workers + queue), CSV export jobs,
  observability, load tests (100+ sources), deployment automation.
