import type { CrawlOutcome } from '@cre/crawler';
import type { AuditLogRow, CrawlRunRow, ListingRow, SourceRow, UserRow } from '@cre/db';
import type {
  AuditLogEntry,
  CrawlRun,
  CrawlRunMetrics,
  CrawlRunWithMetrics,
  CrawlRunStatus,
  Listing,
  ListingFilter,
  Paged,
} from '@cre/shared';
import type { FastifyInstance } from 'fastify';

import { hashPassword } from '../src/auth/passwords';
import { decryptMfaSecret } from '../src/auth/mfa-crypto';
import { buildApp } from '../src/app';
import type {
  AppDeps,
  AuditEvent,
  AuditLogFilter,
  AuditRepo,
  CrawlRunQueryRepo,
  CrawlTrigger,
  ListingQueryRepo,
  MfaChallengeRepo,
  SessionRepo,
  SourceAdminRepo,
  SourceHealthRepo,
  SourcePolicyPatch,
  UserMfaConfig,
  UserRepo,
} from '../src/ports';
import { toAuditLogDto, toCrawlRunDto, toListingDto } from '../src/serializers';

// ── Clock + fixtures ─────────────────────────────────────────────

const FIXED_NOW = new Date('2025-06-01T12:00:00.000Z');
export const fixedNow = (): Date => FIXED_NOW;

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${++seq}`;

export function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: nextId('usr'),
    email: `user-${++seq}@cre.test`,
    displayName: null,
    role: 'viewer',
    passwordHash: 'not-a-real-hash',
    active: true,
    // MFA columns are NOT NULL in the schema; defaults mirror migration 0002.
    mfaEnabled: false,
    mfaSecretEncrypted: null,
    mfaSecretIv: null,
    mfaRecoveryCodes: '[]',
    mfaVerifiedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeSourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: nextId('src'),
    key: `source-${++seq}`,
    name: `Source ${seq}`,
    baseUrl: 'https://example.test',
    enabled: true,
    schedule: '0 3 * * *',
    config: {},
    crawlAllowed: true,
    robotsPolicy: 'honor',
    rateLimitMs: 0,
    maxWorkers: 1,
    authenticationRequired: false,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export function makeListingRow(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id: nextId('lst'),
    sourceId: 'src-1',
    externalId: `ext-${++seq}`,
    sourceUrl: `https://example.test/l/${seq}`,
    title: `Listing ${seq}`,
    description: null,
    propertyType: 'office',
    listingType: 'lease',
    status: 'active',
    streetAddress: null,
    city: null,
    state: null,
    postalCode: null,
    country: 'MX',
    formattedAddress: null,
    lat: null,
    lng: null,
    priceAmount: null,
    priceCurrency: null,
    priceUnit: null,
    sizeValue: null,
    sizeUnit: null,
    lotSizeValue: null,
    lotSizeUnit: null,
    yearBuilt: null,
    unitCount: null,
    listedAt: null,
    firstSeenAt: FIXED_NOW,
    lastSeenAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    raw: {},
    version: 1,
    ...overrides,
  };
}

/**
 * Zeroed CrawlRunMetrics with the same counter derivation `toCrawlRunDto`
 * uses for rows persisted before structured metrics existed.
 */
function defaultCrawlRunMetrics(
  row: Pick<
    CrawlRunRow,
    'id' | 'status' | 'listingsFound' | 'listingsAdded' | 'listingsUpdated' | 'errors'
  >,
): CrawlRunMetrics {
  return {
    runId: row.id,
    status: row.status,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    pagesFailed: 0,
    listingsDiscovered: row.listingsFound,
    listingsAccepted: row.listingsFound,
    listingsRejected: 0,
    duplicateCandidates: 0,
    listingsCreated: row.listingsAdded,
    listingsUpdated: row.listingsUpdated,
    listingsUnchanged: 0,
    parseErrors: 0,
    httpErrors: 0,
    robotsDenials: 0,
    retryCount: 0,
    httpStatusCounts: {},
    requestCount: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    latencySamplesMs: [],
    bytesDownloaded: 0,
    cardsSeen: 0,
    cardsParsed: 0,
    cardsRejected: 0,
    candidatesWithTitle: 0,
    candidatesWithPrice: 0,
    candidatesWithAddress: 0,
    candidatesWithSize: 0,
    candidatesWithPropertyType: 0,
    observationsInserted: 0,
    errors: row.errors,
  };
}

export function makeCrawlRunRow(overrides: Partial<CrawlRunRow> = {}): CrawlRunRow {
  const row: CrawlRunRow = {
    id: nextId('run'),
    sourceId: 'src-1',
    status: 'completed',
    startedAt: FIXED_NOW,
    finishedAt: FIXED_NOW,
    listingsFound: 0,
    listingsAdded: 0,
    listingsUpdated: 0,
    errors: [],
    createdAt: FIXED_NOW,
    metrics: defaultCrawlRunMetrics({
      id: '',
      status: 'completed',
      listingsFound: 0,
      listingsAdded: 0,
      listingsUpdated: 0,
      errors: [],
    }),
    ...overrides,
  };
  // Unless metrics were replaced wholesale, keep the derived counters in sync
  // with the final row values (matches what the crawler persists).
  if (!overrides.metrics) {
    row.metrics = defaultCrawlRunMetrics(row);
  }
  return row;
}

// ── In-memory repositories ───────────────────────────────────────

/** Internal MFA record: the shared config plus at-rest encrypted fields. */
interface FakeMfaRecord extends UserMfaConfig {
  mfaSecretEncrypted?: string;
  mfaSecretIv?: string;
}

export class FakeUserRepo implements UserRepo {
  readonly rows: UserRow[] = [];
  /** Per-user MFA configuration. Keyed by user id. */
  readonly mfaByUserId = new Map<string, FakeMfaRecord>();

  setMfa(userId: string, config: UserMfaConfig): void {
    this.mfaByUserId.set(userId, { ...config });
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    return this.rows.find((row) => row.email === email.toLowerCase()) ?? null;
  }

  async findMfaConfig(userId: string): Promise<UserMfaConfig> {
    const record = this.mfaByUserId.get(userId);
    if (!record) return { mfaEnabled: false };
    // Pending enrollments persist only the encrypted secret; decrypt on read like
    // the Postgres repo so both paths behave identically for the routes.
    if (record.mfaSecretEncrypted && record.mfaSecretIv && !record.mfaSecret) {
      return {
        ...record,
        mfaSecret: decryptMfaSecret(record.mfaSecretEncrypted, record.mfaSecretIv),
      };
    }
    return record;
  }

  async updateMfaRecoveryCodes(userId: string, remainingCodes: string[]): Promise<void> {
    const config = this.mfaByUserId.get(userId);
    if (config) {
      config.mfaRecoveryCodes = [...remainingCodes];
      this.mfaByUserId.set(userId, config);
    }
  }

  async saveMfaEnrollmentSecret(
    userId: string,
    input: { mfaSecretEncrypted: string; mfaSecretIv: string },
    _now: Date,
  ): Promise<void> {
    const record = this.mfaByUserId.get(userId) ?? { mfaEnabled: false };
    record.mfaSecretEncrypted = input.mfaSecretEncrypted;
    record.mfaSecretIv = input.mfaSecretIv;
    this.mfaByUserId.set(userId, record);
  }

  async activateMfa(
    userId: string,
    input: {
      mfaSecretEncrypted: string;
      mfaSecretIv: string;
      hashedRecoveryCodes: string[];
      mfaVerifiedAt: Date;
    },
    _now: Date,
  ): Promise<void> {
    const record = this.mfaByUserId.get(userId) ?? { mfaEnabled: false };
    record.mfaEnabled = true;
    record.mfaSecret = decryptMfaSecret(input.mfaSecretEncrypted, input.mfaSecretIv);
    record.mfaRecoveryCodes = [...input.hashedRecoveryCodes];
    record.mfaVerifiedAt = input.mfaVerifiedAt;
    this.mfaByUserId.set(userId, record);
  }

  async create(
    input: { email: string; displayName?: string; role: UserRow['role']; passwordHash: string },
    now: Date,
  ): Promise<UserRow> {
    const row: UserRow = {
      id: nextId('usr'),
      email: input.email.toLowerCase(),
      displayName: input.displayName ?? null,
      role: input.role,
      passwordHash: input.passwordHash,
      active: true,
      mfaEnabled: false,
      mfaSecretEncrypted: null,
      mfaSecretIv: null,
      mfaRecoveryCodes: '[]',
      mfaVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
  }
}

/** In-memory audit trail. Records events; `list` mirrors the Pg filter/paging. */
export class FakeAuditRepo implements AuditRepo {
  readonly rows: AuditLogRow[] = [];
  private seq = 0;

  async append(event: AuditEvent): Promise<void> {
    this.rows.push({
      id: `audit-${++this.seq}`,
      at: event.at,
      actorUserId: event.actorUserId ?? null,
      actorEmail: event.actorEmail ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? {},
    });
  }

  async list(
    filter: AuditLogFilter,
    page: number,
    pageSize: number,
  ): Promise<Paged<AuditLogEntry>> {
    const filtered = this.rows.filter(
      (row) =>
        (!filter.action || row.action === filter.action) &&
        (!filter.actorUserId || row.actorUserId === filter.actorUserId) &&
        (!filter.from || row.at.getTime() >= filter.from!.getTime()) &&
        (!filter.to || row.at.getTime() <= filter.to!.getTime()),
    );
    filtered.sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id));
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize).map(toAuditLogDto),
      page,
      pageSize,
      total: filtered.length,
    };
  }
}

export class FakeMfaChallengeRepo implements MfaChallengeRepo {
  private readonly store = new Map<string, { userId: string; expiresAt: Date }>();
  private seq = 0;

  async create(input: { userId: string; expiresAt: Date }, _now: Date): Promise<string> {
    const id = `chal-${++this.seq}`;
    this.store.set(id, { userId: input.userId, expiresAt: input.expiresAt });
    return id;
  }

  async consume(challengeId: string, now: Date): Promise<{ userId: string } | null> {
    const record = this.store.get(challengeId);
    if (!record) return null;
    this.store.delete(challengeId);
    if (record.expiresAt.getTime() <= now.getTime()) return null;
    return { userId: record.userId };
  }

  async deleteExpired(now: Date): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.store) {
      if (record.expiresAt.getTime() <= now.getTime()) {
        this.store.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.store.size;
  }
}

export class FakeSessionRepo implements SessionRepo {
  readonly rows: Array<{ userId: string; tokenHash: string; expiresAt: Date }> = [];
  readonly deletedHashes: string[] = [];

  constructor(private readonly users: FakeUserRepo) {}

  async create(
    input: { userId: string; tokenHash: string; expiresAt: Date },
    _now: Date,
  ): Promise<void> {
    this.rows.push({ ...input });
  }

  async findActive(
    tokenHash: string,
    now: Date,
  ): Promise<{ user: UserRow; expiresAt: Date } | null> {
    const session = this.rows.find(
      (row) => row.tokenHash === tokenHash && row.expiresAt.getTime() >= now.getTime(),
    );
    if (!session) return null;
    const user = this.users.rows.find((row) => row.id === session.userId);
    return user ? { user, expiresAt: session.expiresAt } : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.tokenHash === tokenHash);
    if (index >= 0) this.rows.splice(index, 1);
    this.deletedHashes.push(tokenHash);
  }

  async deleteExpired(now: Date): Promise<number> {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i].expiresAt.getTime() < now.getTime()) this.rows.splice(i, 1);
    }
    return before - this.rows.length;
  }
}

export class FakeListingQueryRepo implements ListingQueryRepo {
  readonly rows: ListingRow[] = [];
  readonly sourceKeyById = new Map<string, string>();

  constructor(rows: ListingRow[] = []) {
    this.rows.push(...rows);
  }

  keyOf(row: ListingRow): string {
    return this.sourceKeyById.get(row.sourceId) ?? 'unknown-source';
  }

  async search(filter: ListingFilter, page: number, pageSize: number): Promise<Paged<Listing>> {
    let items = [...this.rows];
    if (filter.q) {
      const needle = filter.q.toLowerCase();
      items = items.filter((row) =>
        [row.title, row.description, row.formattedAddress].some(
          (value) => value !== null && value.toLowerCase().includes(needle),
        ),
      );
    }
    if (filter.propertyTypes?.length) {
      items = items.filter((row) => filter.propertyTypes!.includes(row.propertyType));
    }
    if (filter.listingTypes?.length) {
      items = items.filter((row) => filter.listingTypes!.includes(row.listingType));
    }
    if (filter.statuses?.length) {
      items = items.filter((row) => filter.statuses!.includes(row.status));
    }
    if (filter.sourceKeys?.length) {
      items = items.filter((row) => filter.sourceKeys!.includes(this.keyOf(row)));
    }
    if (filter.states?.length) {
      items = items.filter((row) => row.state !== null && filter.states!.includes(row.state));
    }
    if (filter.cities?.length) {
      items = items.filter((row) => row.city !== null && filter.cities!.includes(row.city));
    }
    if (filter.minPrice !== undefined) {
      items = items.filter(
        (row) => row.priceAmount !== null && Number(row.priceAmount) >= filter.minPrice!,
      );
    }
    if (filter.maxPrice !== undefined) {
      items = items.filter(
        (row) => row.priceAmount !== null && Number(row.priceAmount) <= filter.maxPrice!,
      );
    }
    if (filter.updatedSince) {
      const since = new Date(filter.updatedSince).getTime();
      items = items.filter((row) => row.updatedAt.getTime() >= since);
    }
    items.sort(
      (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.id.localeCompare(b.id),
    );

    const start = (page - 1) * pageSize;
    return {
      items: items.slice(start, start + pageSize).map((row) => toListingDto(row, this.keyOf(row))),
      page,
      pageSize,
      total: items.length,
    };
  }

  async findById(id: string): Promise<Listing | null> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? toListingDto(row, this.keyOf(row)) : null;
  }
}

export class FakeSourceAdminRepo implements SourceAdminRepo {
  readonly rows: SourceRow[];

  constructor(rows: SourceRow[] = []) {
    this.rows = [...rows];
  }

  async list(): Promise<SourceRow[]> {
    return [...this.rows].sort((a, b) => a.key.localeCompare(b.key));
  }

  async findByKey(key: string): Promise<SourceRow | null> {
    return this.rows.find((row) => row.key === key) ?? null;
  }

  async updatePolicy(key: string, patch: SourcePolicyPatch, now: Date): Promise<SourceRow | null> {
    const row = this.rows.find((candidate) => candidate.key === key);
    if (!row) return null;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.crawlAllowed !== undefined) row.crawlAllowed = patch.crawlAllowed;
    if (patch.robotsPolicy !== undefined) row.robotsPolicy = patch.robotsPolicy;
    if (patch.rateLimitMs !== undefined) row.rateLimitMs = patch.rateLimitMs;
    if (patch.maxWorkers !== undefined) row.maxWorkers = patch.maxWorkers;
    row.updatedAt = now;
    return row;
  }
}

export class FakeCrawlRunQueryRepo implements CrawlRunQueryRepo {
  readonly rows: Array<{ row: CrawlRunRow; sourceKey: string }> = [];

  add(row: CrawlRunRow, sourceKey: string): void {
    this.rows.push({ row, sourceKey });
  }

  async list(
    filter: { sourceKey?: string; statuses?: CrawlRunStatus[] },
    page: number,
    pageSize: number,
  ): Promise<Paged<CrawlRunWithMetrics>> {
    let entries = [...this.rows];
    if (filter.sourceKey) {
      entries = entries.filter((entry) => entry.sourceKey === filter.sourceKey);
    }
    if (filter.statuses?.length) {
      entries = entries.filter((entry) => filter.statuses!.includes(entry.row.status));
    }
    entries.sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime());

    const start = (page - 1) * pageSize;
    return {
      items: entries
        .slice(start, start + pageSize)
        .map((entry) => toCrawlRunDto(entry.row, entry.sourceKey)),
      page,
      pageSize,
      total: entries.length,
    };
  }

  async findById(id: string): Promise<CrawlRunWithMetrics | null> {
    const entry = this.rows.find((e) => e.row.id === id);
    return entry ? toCrawlRunDto(entry.row, entry.sourceKey) : null;
  }

  async recentForSource(sourceKey: string, limit: number): Promise<CrawlRunWithMetrics[]> {
    return [...this.rows]
      .filter((entry) => entry.sourceKey === sourceKey)
      .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime())
      .slice(0, limit)
      .map((entry) => toCrawlRunDto(entry.row, entry.sourceKey));
  }

  async createQueued(input: {
    sourceId: string;
    requestedAt: Date;
    requestedByUserId: string | null;
    urls: readonly string[];
  }): Promise<string> {
    const row: CrawlRunRow = {
      id: nextId('run'),
      sourceId: input.sourceId,
      status: 'queued',
      startedAt: input.requestedAt,
      requestedByUserId: input.requestedByUserId,
      urls: [...input.urls],
      createdAt: input.requestedAt,
      metrics: defaultCrawlRunMetrics({
        id: '',
        status: 'queued',
        listingsFound: 0,
        listingsAdded: 0,
        listingsUpdated: 0,
        errors: [],
      }),
    };
    this.rows.push({ row, sourceId: input.sourceId });
    return row.id;
  }
}

export class FakeSourceHealthRepo implements SourceHealthRepo {
  readonly runs: Array<{ sourceKey: string; run: CrawlRunRow }> = [];

  add(run: CrawlRunRow, sourceKey: string): void {
    this.runs.push({ sourceKey, run });
  }

  async recentRuns(sourceKey: string, limit: number): Promise<CrawlRunWithMetrics[]> {
    return [...this.runs]
      .filter((entry) => entry.sourceKey === sourceKey)
      .sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime())
      .slice(0, limit)
      .map((entry) => toCrawlRunDto(entry.run, entry.sourceKey));
  }
}

export class FakeCrawlTrigger implements CrawlTrigger {
  readonly calls: Array<{ source: SourceRow; urls: readonly string[] }> = [];

  constructor(
    private readonly adapters: ReadonlySet<string> = new Set(['vivanuncios']),
    private readonly overrides: Partial<CrawlOutcome> = {},
  ) {}

  hasAdapter(sourceKey: string): boolean {
    return this.adapters.has(sourceKey);
  }

  async trigger(source: SourceRow, urls: readonly string[]): Promise<CrawlOutcome> {
    this.calls.push({ source, urls });
    return {
      runId: 'run-new',
      status: 'completed',
      pagesFetched: 1,
      pagesFailed: 0,
      candidatesFound: 1,
      candidatesDeduped: 0,
      listingsAdded: 1,
      listingsUpdated: 0,
      listingsUnchanged: 0,
      errors: [],
      metrics: {
        ...defaultCrawlRunMetrics({
          id: 'run-new',
          status: 'completed',
          listingsFound: 1,
          listingsAdded: 1,
          listingsUpdated: 0,
          errors: [],
        }),
        startedAt: FIXED_NOW.toISOString(),
        finishedAt: FIXED_NOW.toISOString(),
        pagesAttempted: 1,
        pagesSucceeded: 1,
        pagesFailed: 0,
      },
      ...this.overrides,
    };
  }
}

// ── Harness + helpers ────────────────────────────────────────────

export interface TestHarness {
  deps: AppDeps;
  users: FakeUserRepo;
  sessions: FakeSessionRepo;
  listings: FakeListingQueryRepo;
  sources: FakeSourceAdminRepo;
  crawlRuns: FakeCrawlRunQueryRepo;
  health: FakeSourceHealthRepo;
  crawl: FakeCrawlTrigger;
  mfaChallenges: FakeMfaChallengeRepo;
  audit: FakeAuditRepo;
  app: FastifyInstance;
}

export async function buildTestHarness(
  options: {
    sources?: SourceRow[];
    listings?: ListingRow[];
    crawlRuns?: Array<{ row: CrawlRunRow; sourceKey: string }>;
    sourceKeysById?: Record<string, string>;
    /** Merged over the defaults in `deps` — security knobs, logger, clock. */
    deps?: Partial<AppDeps>;
  } = {},
): Promise<TestHarness> {
  const users = new FakeUserRepo();
  const sessions = new FakeSessionRepo(users);
  const listings = new FakeListingQueryRepo(options.listings ?? []);
  for (const [sourceId, key] of Object.entries(options.sourceKeysById ?? {})) {
    listings.sourceKeyById.set(sourceId, key);
  }
  const sources = new FakeSourceAdminRepo(options.sources ?? []);
  const crawlRuns = new FakeCrawlRunQueryRepo();
  for (const entry of options.crawlRuns ?? []) {
    crawlRuns.add(entry.row, entry.sourceKey);
  }
  const health = new FakeSourceHealthRepo();
  for (const entry of options.crawlRuns ?? []) {
    health.add(entry.row, entry.sourceKey);
  }
  const crawl = new FakeCrawlTrigger();
  const mfaChallenges = new FakeMfaChallengeRepo();
  const audit = new FakeAuditRepo();

  const deps: AppDeps = {
    users,
    sessions,
    listings,
    sources,
    crawlRuns,
    health,
    crawl,
    mfaChallenges,
    audit,
    sessionTtlHours: 24,
    now: fixedNow,
    ...options.deps,
  };
  const app = await buildApp(deps);
  return {
    deps,
    users,
    sessions,
    listings,
    sources,
    crawlRuns,
    health,
    crawl,
    mfaChallenges,
    audit,
    app,
  };
}

export async function createUser(
  users: UserRepo,
  overrides: { email?: string; password?: string; role?: UserRow['role']; active?: boolean } = {},
): Promise<UserRow> {
  const row = await users.create(
    {
      email: overrides.email ?? 'operator@cre.test',
      role: overrides.role ?? 'operator',
      passwordHash: await hashPassword(overrides.password ?? 'secret123'),
    },
    fixedNow(),
  );
  if (overrides.active !== undefined) row.active = overrides.active;
  return row;
}

export async function login(
  app: FastifyInstance,
  email = 'operator@cre.test',
  password = 'secret123',
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed (${response.statusCode}): ${response.body}`);
  }
  return (response.json() as { token: string }).token;
}