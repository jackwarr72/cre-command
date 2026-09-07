import { describe, expect, it } from 'vitest';

import { buildTestHarness, createUser, login, makeSourceRow, makeCrawlRunRow } from './fakes';

describe('GET /api/dashboard', () => {
  it('requires authentication', async () => {
    const h = await buildTestHarness({ sources: [makeSourceRow({ key: 'vivanuncios' })] });
    await createUser(h.users, { email: 'operator@cre.test', role: 'operator' });

    const response = await h.app.inject({ method: 'GET', url: '/api/dashboard' });
    expect(response.statusCode).toBe(401);
  });

  it('aggregates sources, listings, runs, and source health', async () => {
    const vivanuncios = makeSourceRow({
      key: 'vivanuncios',
      name: 'Vivanuncios',
      enabled: true,
      crawlAllowed: true,
      robotsPolicy: 'honor',
    });
    const idealista = makeSourceRow({
      key: 'idealista',
      name: 'Idealista',
      enabled: false,
      crawlAllowed: false,
      robotsPolicy: 'strict',
    });

    const completedRun = makeCrawlRunRow({
      sourceId: vivanuncios.id,
      status: 'completed',
      listingsFound: 10,
      listingsAdded: 8,
      listingsUpdated: 0,
      startedAt: new Date('2025-06-01T11:55:00.000Z'),
      finishedAt: new Date('2025-06-01T12:00:00.000Z'),
    });
    const failedRun = makeCrawlRunRow({
      sourceId: idealista.id,
      status: 'failed',
      listingsFound: 0,
      listingsAdded: 0,
      listingsUpdated: 0,
      startedAt: new Date('2025-06-01T10:00:00.000Z'),
      finishedAt: new Date('2025-06-01T10:01:00.000Z'),
    });

    const h = await buildTestHarness({
      sources: [vivanuncios, idealista],
      crawlRuns: [
        { row: completedRun, sourceKey: 'vivanuncios' },
        { row: failedRun, sourceKey: 'idealista' },
      ],
    });
    await createUser(h.users, { email: 'operator@cre.test', role: 'operator' });
    const token = await login(h.app, 'operator@cre.test');

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.sources.total).toBe(2);
    expect(body.sources.active).toBe(1); // only vivanuncios is enabled + crawlAllowed
    expect(body.sources.withErrors).toBeGreaterThanOrEqual(1); // idealista is disabled/failed

    expect(body.runs.total).toBe(2);
    expect(body.runs.completed).toBe(1);
    expect(body.runs.failed).toBe(1);
    expect(body.runs.successRate).toBeCloseTo(0.5);
    expect(body.runs.last24hCount).toBe(2); // both runs finished within 24h of FIXED_NOW

    expect(body.recentRuns).toHaveLength(2);
    expect(body.sourceHealth).toHaveLength(2);
    expect(body.sourceHealth.map((h: { sourceKey: string }) => h.sourceKey).sort()).toEqual(
      ['idealista', 'vivanuncios'],
    );
  });

  it('returns empty data when no sources or runs exist', async () => {
    const h = await buildTestHarness({ sources: [] });
    await createUser(h.users, { email: 'operator@cre.test', role: 'operator' });
    const token = await login(h.app, 'operator@cre.test');

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.sources.total).toBe(0);
    expect(body.sources.active).toBe(0);
    expect(body.runs.total).toBe(0);
    expect(body.runs.successRate).toBe(0);
    expect(body.recentRuns).toEqual([]);
    expect(body.sourceHealth).toEqual([]);
  });

  it('counts runs finished within the last 24h', async () => {
    const source = makeSourceRow({ key: 'vivanuncios' });
    const recentRun = makeCrawlRunRow({
      sourceId: source.id,
      status: 'completed',
      startedAt: new Date('2025-06-01T11:00:00.000Z'),
      finishedAt: new Date('2025-06-01T11:55:00.000Z'),
    });
    const oldRun = makeCrawlRunRow({
      sourceId: source.id,
      status: 'completed',
      startedAt: new Date('2025-05-25T12:00:00.000Z'),
      finishedAt: new Date('2025-05-25T12:05:00.000Z'),
    });

    const h = await buildTestHarness({
      sources: [source],
      crawlRuns: [
        { row: recentRun, sourceKey: 'vivanuncios' },
        { row: oldRun, sourceKey: 'vivanuncios' },
      ],
    });
    await createUser(h.users, { email: 'operator@cre.test', role: 'operator' });
    const token = await login(h.app, 'operator@cre.test');

    const response = await h.app.inject({
      method: 'GET',
      url: '/api/dashboard',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = response.json();
    expect(body.runs.total).toBe(2);
    expect(body.runs.last24hCount).toBe(1);
  });
});
