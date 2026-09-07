import type { CrawlOutcome } from '@cre/crawler';
import type { CrawlRunRow, ListingRow, SourceRow, UserRow } from '@cre/db';
import type {
  CrawlRun,
  CrawlRunWithMetrics,
  CrawlRunStatus,
  Listing,
  ListingFilter,
  Paged,
} from '@cre/shared';
import type { FastifyInstance } from 'fastify';

import { hashPassword } from '../src/auth/passwords';
import { buildApp } from '../src/app';
import type {
  AppDeps,
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
import { toCrawlRunDto, toListingDto } from '../src/serializers';

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

export function makeCrawlRunRow(overrides: Partial<CrawlRunRow> = {}): CrawlRunRow {
  return {
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
    ...overrides,
  };
}

// ── In-memory repositories ───────────────────────────────────────

export class FakeUserRepo implements UserRepo {
  readonly rows: UserRow[] = [];
  /** Per-user MFA configuration. Keyed by user id. */
  readonly mfaByUserId = new Map<string, UserMfaConfig>();

  setMfa(userId: string, config: UserMfaConfig): void {
    this.mfaByUserId.set(userId, config);
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    return this.rows.find((row) => row.email === email.toLowerCase()) ?? null;
  }

  async findMfaConfig(userId: string): Promise<UserMfaConfig> {
    return this.mfaByUserId.get(userId) ?? { mfaEnabled: false };
  }

  async updateMfaRecoveryCodes(userId: string, remainingCodes: string[]): Promise<void> {
    const config = this.mfaByUserId.get(userId);
    if (config) {
      config.mfaRecoveryCodes = remainingCodes;
      this.mfaByUserId.set(userId, config);
    }
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
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
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
        runId: 'run-new',
        status: 'completed',
        startedAt: FIXED_NOW.toISOString(),
        finishedAt: FIXED_NOW.toISOString(),
        pagesAttempted: 1,
        pagesSucceeded: 1,
        pagesFailed: 0,
        listingsDiscovered: 1,
        listingsAccepted: 1,
        listingsRejected: 0,
        duplicateCandidates: 0,
        listingsCreated: 1,
        listingsUpdated: 0,
        listingsUnchanged: 0,
        parseErrors: 0,
        httpErrors: 0,
        robotsDenials: 0,
        errors: [],
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

  const deps: AppDeps = {
    users,
    sessions,
    listings,
    sources,
    crawlRuns,
    health,
    crawl,
    mfaChallenges,
    sessionTtlHours: 24,
    now: fixedNow,
    ...options.deps,
  };
  const app = await buildApp(deps);
  return { deps, users, sessions, listings, sources, crawlRuns, health, crawl, mfaChallenges, app };
}

export async function createUser(
  users: FakeUserRepo,
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