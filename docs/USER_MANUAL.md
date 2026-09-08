# cre-command — User Manual

**Commercial Real Estate intelligence, crawling & lead-generation control panel.**

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installation & Setup](#2-installation--setup)
3. [Authentication](#3-authentication)
4. [Running the System](#4-running-the-system)
5. [Triggering Crawls](#5-triggering-crawls)
6. [Monitoring Crawl Runs](#6-monitoring-crawl-runs)
7. [Managing Sources](#7-managing-sources)
8. [Using the API](#8-using-the-api)
9. [Workers & Async Processing](#9-workers--async-processing)
10. [Testing](#10-testing)
11. [Configuration Reference](#11-configuration-reference)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Prerequisites

- **Node.js** 22.x or later
- **PostgreSQL** 16+ (or a Docker container)
- **Redis** 7+ (optional; required for async worker mode and MFA challenges)
- npm (comes with Node.js)

### Verify prerequisites

```bash
node --version        # should be 22.x+
psql --version        # should be 16.x+
redis-cli --version   # optional
```

---

## 2. Installation & Setup

### 2.1 Clone the repository

```bash
git clone <repo-url>
cd cre-command
```

### 2.2 Install dependencies

```bash
npm install
```

This installs dependencies for all workspaces.

### 2.3 Set up the database

Edit `.env` to configure your database connection:

```env
DATABASE_URL=postgres://user:password@localhost:5432/cre_command
```

Create the database if it doesn't exist:

```bash
createdb cre_command
```

Run migrations:

```bash
npx drizzle-kit migrate
```

### 2.4 Bootstrap an admin account (first-time setup only)

The first bootstraps an admin account when the `users` table is empty.

Set these environment variables in `.env`:

```env
CRE_ADMIN_EMAIL=admin@cre.local
CRE_ADMIN_PASSWORD=use-a-password-manager
```

> **Security note:** Change the default password immediately after first login. Remove these variables once operator accounts exist.

### 2.5 Start the system

```bash
npm run dev          # Starts web (3000) + API (4000) together
```

Open **http://localhost:3000** in your browser.

---

## 3. Authentication

### 3.1 Login

Navigate to the login page or call the API:

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cre.local","password":"change-me-immediately"}'
```

Response:
```json
{
  "user": { "id": "...", "email": "admin@cre.local", "role": "admin" },
  "token": "Bearer ...",
  "expiresAt": "2025-06-08T12:00:00.000Z"
}
```

Use the returned token for subsequent requests:
```bash
Authorization: Bearer <token>
```

### 3.2 Roles

| Role | Permissions |
|------|------------|
| `viewer` | Read-only access |
| `operator` | Trigger crawls, view audit log |
| `admin` | Full access including user management and source policy changes |

### 3.3 Multi-Factor Authentication (TOTP)

MFA is optional but recommended:

1. **Enroll**: `POST /auth/mfa/enroll` → returns a secret and `otpauth://` URL
2. **Add to authenticator app** (Google Authenticator, Authy, etc.)
3. **Confirm**: `POST /auth/mfa/confirm` with the 6-digit code
4. **Login with MFA**: after confirming, login requires both password and TOTP code
5. **Recovery codes**: 10 single-use codes provided at enrollment — store them securely

### 3.4 Session management

- Sessions are opaque bearer tokens
- Default TTL: 168 hours (7 days)
- Sessions are stored as SHA-256 hashes
- Sessions can be revoked via `POST /auth/logout`

---

## 4. Running the System

### 4.1 Development mode

```bash
npm run dev          # web (3000) + api (4000) together
```

### 4.2 Production mode

```bash
npm run build        # Build all packages
npm start            # Start the API server
```

### 4.3 Available scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start all services in dev mode |
| `npm run typecheck` | TypeScript strict check across all packages (8 passes) |
| `npm run test:unit` | Run 254 unit tests (no services required) |
| `npm run test:integration` | Run integration tests with live Postgres/Redis |
| `npm run build:web` | Production build of Next.js frontend |
| `npm run build` | Build all packages |

---

## 5. Triggering Crawls

### 5.1 Overview

Crawls can be triggered in two modes:

1. **Synchronous (development)**: The crawl runs to completion within the HTTP request. Returns the result directly.
2. **Asynchronous/queued (production)**: A `crawl_run` record is created with `status: 'queued'`, an outbox event is inserted, and the HTTP response returns `202 Accepted`. A background worker picks up the job.

The mode is selected automatically at runtime: when Redis is configured, the async path is used.

### 5.2 Triggering a crawl via API

```bash
curl -X POST http://localhost:4000/api/crawl-runs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"sourceKey": "vivanuncios", "urls": ["https://example.com/listings"]}'
```

**Parameters:**
- `sourceKey` (required): The adapter key for the source (e.g., `vivanuncios`)
- `urls` (optional): Array of entry-point URLs. If omitted, falls back to `entryUrls` configured on the source.

**Response (async mode):**
```json
{
  "crawlRun": {
    "id": "uuid",
    "status": "queued"
  }
}
```

**Response (sync mode):**
```json
{
  "runId": "uuid",
  "status": "completed",
  "listingsFound": 42,
  "listingsAdded": 10,
  "listingsUpdated": 5,
  "listingsUnchanged": 27,
  ...
}
```

### 5.3 Invariant

> A persisted queued crawl run will eventually have a corresponding queue job, or be visibly recoverable as an unpublished outbox record.

This means even if the worker crashes, the crawl run is still recoverable via the outbox table.

---

## 6. Monitoring Crawl Runs

### 6.1 List crawl runs

```bash
curl -X GET "http://localhost:4000/api/crawl-runs?sourceKey=vivanuncios&status=queued&page=0&pageSize=20" \
  -H "Authorization: Bearer <token>"
```

**Query parameters:**
- `sourceKey` (optional): Filter by source key
- `status` (optional): Filter by status (`queued`, `running`, `completed`, `completed_with_errors`, `failed`, `cancelled`)
- `page` (optional): Page number (default 0)
- `pageSize` (optional): Results per page (default 20)

### 6.2 Get run details

```bash
curl -X GET http://localhost:4000/api/crawl-runs/{id} \
  -H "Authorization: Bearer <token>"
```

Includes errors, metrics, and timestamps.

### 6.3 Crawl run statuses

| Status | Meaning |
|--------|---------|
| `queued` | Waiting for a worker to pick up |
| `running` | Being executed by a worker |
| `completed` | Successfully finished |
| `completed_with_errors` | Finished but with some errors |
| `failed` | Fatal error during execution |
| `cancelled` | Policy gate rejected the crawl |

---

## 7. Managing Sources

### 7.1 List sources

```bash
curl -X GET http://localhost:4000/api/sources \
  -H "Authorization: Bearer <token>"
```

### 7.2 Update source policy

```bash
curl -X PATCH http://localhost:4000/api/sources/vivanuncios \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "crawlAllowed": true, "robotsPolicy": "honor", "rateLimitMs": 5000, "maxWorkers": 3}'
```

**Policy fields:**
- `enabled`: Whether the source is active
- `crawlAllowed`: Whether crawling is permitted
- `robotsPolicy`: `strict` | `honor` | `allow` (RFC 9309 subset)
- `rateLimitMs`: Per-source rate limit in milliseconds
- `maxWorkers`: Maximum parallel workers per source
- `authenticationRequired`: Whether authentication is required

### 7.3 Add a new source adapter

Adding a new source = adding a new adapter folder in `packages/adapters/src/sources/{sourceKey}/`. No engine changes required. The `AdapterRegistry` auto-discovers adapters.

---

## 8. Using the API

### 8.1 Base URL

All API endpoints are prefixed with `/api`. When using the web app, requests are proxied through `/api/*`.

### 8.2 Authentication header

All authenticated endpoints require:
```
Authorization: Bearer <token>
```

### 8.3 Error format

```json
{
  "error": {
    "message": "Human-readable error message",
    "code": "ERROR_CODE"
  }
}
```

### 8.4 API Endpoints

#### Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/login` | None | Login with email/password |
| POST | `/auth/login/mfa-verify` | None | Complete MFA login |
| GET | `/auth/me` | Yes | Get current user |
| POST | `/auth/logout` | Yes | Revoke session |
| POST | `/auth/mfa/enroll` | Yes | Start MFA enrollment |
| POST | `/auth/mfa/confirm` | Yes | Confirm MFA enrollment |

#### Sources

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sources` | Yes | List sources |
| PATCH | `/sources/:key` | Operator/Admin | Update source policy |

#### Crawl Runs

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/crawl-runs` | Yes | List crawl runs |
| GET | `/crawl-runs/:id` | Yes | Get run details |
| POST | `/crawl-runs` | Operator/Admin | Trigger a crawl |

#### Listings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/listings` | Yes | Search listings (filters in query) |
| GET | `/listings/:id` | Yes | Get listing details |

#### Audit Log

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/audit-log` | Operator/Admin | Append-only audit trail |

#### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Liveness check |

### 8.5 Listing filters

```bash
curl -X GET "http://localhost:4000/api/listings?q=office&propertyTypes=office&listingTypes=for-lease&states=TX&cities=Austin&minPrice=100000&maxPrice=5000000&updatedSince=2025-01-01&page=0&pageSize=20" \
  -H "Authorization: Bearer <token>"
```

---

## 9. Workers & Async Processing

### 9.1 Architecture

The system supports two execution modes:

```
┌──────────┐     POST /crawl-runs      ┌──────────┐
│   web    │ ────────────────────────▶ │   API    │
│          │                           │          │
│          │                           │  creates │
│          │                           │  crawl_  │
│          │                           │  run     │
│          │                           │  + outbox│
└──────────┘                           └────┬─────┘
                                           │
                                           ▼
                                    ┌──────────────┐
                                    │  Outbox table│
                                    │  (Postgres)  │
                                    └──────┬───────┘
                                           │ poll
                                           ▼
                                    ┌──────────────┐
                                    │  Worker      │
                                    │  (in-process)│
                                    │  or standalone│
                                    └──────┬───────┘
                                           │
                                           ▼
                                    ┌──────────────┐
                                    │  Crawler     │
                                    │  Engine      │
                                    └──────────────┘
```

### 9.2 Transactional Outbox Pattern

When a crawl is triggered in async mode:

1. API creates a `crawl_run` row with `status: 'queued'` and stores URLs
2. API creates an outbox event (status: `pending`) in the same logical transaction
3. API returns `202 Accepted` to the client
4. Worker polls the outbox table for pending events
5. Worker claims the crawl run atomically (`claimForExecution`)
6. Worker executes the crawl via `executeExistingRun`
7. Worker completes the outbox event

> **Invariant**: A persisted queued crawl run will eventually have a corresponding queue job, or be visibly recoverable as an unpublished outbox record.

### 9.3 Running workers

The worker package (`packages/workers`) handles background job consumption:

```bash
# Start a worker
cd packages/workers
npm run dev
```

### 9.4 Queue configuration

Workers use the `OutboxRepo` to poll for pending jobs. The queue abstraction supports:
- **In-memory** (for tests)
- **Redis-backed** (for production)

Set `REDIS_URL` in `.env` for Redis-backed queues:
```env
REDIS_URL=redis://localhost:6379
```

### 9.5 Job payload

Crawl job payload (stored in outbox):
```json
{
  "crawlRunId": "uuid",
  "sourceId": "uuid",
  "requestedByUserId": "uuid | null",
  "requestedAt": "2025-06-08T12:00:00.000Z"
}
```

---

## 10. Testing

### 10.1 Unit tests

```bash
npm run test:unit
```

**254 tests**, no services required. Uses in-memory fakes for repositories.

### 10.2 Integration tests

```bash
DATABASE_URL=postgres://user:password@localhost:5432/cre_command \
REDIS_URL=redis://localhost:6379 \
npm run test:integration
```

Requires live PostgreSQL and Redis. Creates temporary tables and drops them after tests.

### 10.3 Test structure

- `packages/api/test/fakes.ts` — In-memory repository fakes
- `packages/crawler/test/` — Crawler pipeline tests
- `packages/adapters/test/` — Adapter parsing tests
- `packages/api/test/` — API route tests

### 10.4 Type checking

```bash
npm run typecheck
```

All 8 workspaces must pass strict TypeScript checks.

---

## 11. Configuration Reference

### 11.1 Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://cre:secret@localhost:5432/cre_command` | PostgreSQL connection string |
| `PORT` | `4000` | API server port |
| `HOST` | `0.0.0.0` | API server host |
| `NODE_ENV` | `development` | Environment mode |
| `REDIS_URL` | — | Redis connection string (optional) |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins |
| `RATE_LIMIT_MAX` | `300` | Max requests per sliding window per IP |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration in ms |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Login-specific rate limit |
| `BODY_LIMIT_BYTES` | `1048576` | Request body size limit (1 MB) |
| `TRUST_PROXY` | `false` | Trust X-Forwarded-For |
| `LOG_LEVEL` | `info` | Pino log level |
| `CRE_ADMIN_EMAIL` | — | Bootstrap admin email |
| `CRE_ADMIN_PASSWORD` | — | Bootstrap admin password |
| `CRE_SESSION_TTL_HOURS` | `168` | Session TTL (1h–2160h) |
| `SESSION_PRUNE_INTERVAL_MS` | `3600000` | Session pruning interval (0 = disabled) |
| `MFA_ENCRYPTION_KEY` | — | Base64-encoded 32-byte key for TOTP secrets |
| `MFA_ENCRYPTION_KEY` | — | Base64-encoded 32-byte key for TOTP secrets |

### 11.2 Configuration files

- `.env` — Local development environment (committed in `.gitignore`)
- `.env.example` — Production template
- `packages/api/src/config.ts` — Runtime configuration loading

---

## 12. Troubleshooting

### 12.1 Crawl runs stuck in `queued` state

**Cause**: Worker is not running or cannot poll the outbox table.

**Fix**:
1. Verify the worker process is running
2. Check that `REDIS_URL` is configured if using Redis queues
3. Check the outbox table for pending records:
   ```sql
   SELECT * FROM outbox WHERE status = 'pending';
   ```

### 12.2 Crawl runs stuck in `running` state

**Cause**: Worker crashed during execution.

**Fix**: No automatic recovery needed — the run will remain `running`. Manually update:
```sql
UPDATE crawl_runs SET status = 'failed', finishedAt = NOW() WHERE id = '{runId}';
```

### 12.3 Connection refused to PostgreSQL

**Cause**: Database not running or wrong `DATABASE_URL`.

**Fix**:
```bash
# Check if PostgreSQL is running
psql -h localhost -U cre -d cre_command -c "SELECT 1;"

# Verify DATABASE_URL in .env matches your setup
```

### 12.4 Migration errors

**Cause**: Schema changes not applied to the database.

**Fix**:
```bash
npx drizzle-kit migrate
```

### 12.5 Type check failures

**Cause**: TypeScript errors in any workspace.

**Fix**:
```bash
npm run typecheck    # Shows all type errors across packages
```

### 12.6 MFA enrollment fails

**Cause**: `MFA_ENCRYPTION_KEY` not set in `.env`.

**Fix**: Generate a key:
```bash
openssl rand -base64 32
```

Add to `.env`:
```env
MFA_ENCRYPTION_KEY=your-generated-key-here
```

---

## Appendix: Quick Reference

### Common URLs

| Service | URL |
|---------|-----|
| Web app | http://localhost:3000 |
| API | http://localhost:4000 |
| Health check | http://localhost:4000/health |

### Default Credentials

| Field | Value |
|-------|-------|
| Email | `admin@cre.local` |
| Password | `change-me-immediately` |
| Role | `admin` |

> **Change these immediately after first login!**

### Useful SQL Queries

```sql
-- Check pending outbox events
SELECT * FROM outbox WHERE status = 'pending';

-- Check stuck running runs
SELECT * FROM crawl_runs WHERE status = 'running';

-- Check crawl run metrics
SELECT id, status, listings_found, listings_added, listings_updated, errors 
FROM crawl_runs ORDER BY created_at DESC LIMIT 20;

-- Queue depth
SELECT COUNT(*) FROM outbox WHERE status = 'pending';
```
