import { describe, expect, it } from 'vitest';

import {
  buildTestHarness,
  createUser,
  login,
  makeCrawlRunRow,
  makeSourceRow,
} from './fakes';

async function harnessWithRuns() {
  const sources = [
    makeSourceRow({ key: 'vivanuncios', config: { entryUrls: ['https://example.test/entry'] } }),
    makeSourceRow({ key: 'inmuebles24' }),
  ];
  const h = await buildTestHarness({
    sources,
    crawlRuns: [
      {
        row: makeCrawlRunRow({ status: 'completed', listingsFound: 3, listingsAdded: 3 }),
        sourceKey: 'vivanuncios',
      },
      {
        row: makeCrawlRunRow({
          status: 'failed',
          createdAt: new Date('2025-06-02T12:00:00.000Z'),
          errors: [{ message: 'robots denied', retries: 0, at: '2025-06-01T12:00:00.000Z' }],
        }),
        sourceKey: 'inmuebles24',
      },
    ],
  });
  await createUser(h.users, { email: 'operator@cre.test', role: 'operator' });
  await createUser(h.users, { email: 'viewer@cre.test', role: 'viewer' });
  const operatorToken = await login(h.app, 'operator@cre.test');
  const viewerToken = await login(h.app, 'viewer@cre.test');
  return {
    h,
    crawl: h.crawl,
    operatorHeaders: { authorization: `Bearer ${operatorToken}` },
    viewerHeaders: { authorization: `Bearer ${viewerToken}` },
  };
}

describe('GET /api/crawl-runs', () => {
  it('requires authentication', async () => {
    const { h } = await harnessWithRuns();
    const response = await h.app.inject({ method: 'GET', url: '/api/crawl-runs' });
    expect(response.statusCode).toBe(401);
  });

  it('lists runs paged, with the source key resolved onto the shared CrawlRun shape', async () => {
    const { h, operatorHeaders } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    for (const run of body.items) {
      expect(typeof run.sourceKey).toBe('string');
      expect(['completed', 'failed']).toContain(run.status);
      expect(Array.isArray(run.errors)).toBe(true);
    }
    // Newest first: the failed run was created second.
    expect(body.items[0].status).toBe('failed');
  });

  it('filters by sourceKey and status, validating status values', async () => {
    const { h, operatorHeaders } = await harnessWithRuns();

    const bySource = await h.app.inject({
      method: 'GET',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      query: { sourceKey: 'vivanuncios' },
    });
    expect(bySource.json().total).toBe(1);
    expect(bySource.json().items[0].sourceKey).toBe('vivanuncios');

    const byStatus = await h.app.inject({
      method: 'GET',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      query: { status: 'completed' },
    });
    expect(byStatus.json().total).toBe(1);

    const invalid = await h.app.inject({
      method: 'GET',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      query: { status: 'exploded' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toContain('status');
  });
});

describe('POST /api/crawl-runs', () => {
  it('requires authentication', async () => {
    const { h } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      payload: { sourceKey: 'vivanuncios' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('forbids viewers (403)', async () => {
    const { h, viewerHeaders } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers: viewerHeaders,
      payload: { sourceKey: 'vivanuncios' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('lets an operator trigger a crawl and returns the outcome', async () => {
    const { h, operatorHeaders, crawl } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      payload: { sourceKey: 'vivanuncios', urls: ['https://example.test/page/1'] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runId: 'run-new',
      status: 'completed',
      listingsAdded: 1,
    });
    expect(crawl.calls).toHaveLength(1);
    expect(crawl.calls[0].source.key).toBe('vivanuncios');
    expect(crawl.calls[0].urls).toEqual(['https://example.test/page/1']);
  });

  it('falls back to the source-configured entryUrls when none are passed', async () => {
    const { h, operatorHeaders, crawl } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      payload: { sourceKey: 'vivanuncios' },
    });

    expect(response.statusCode).toBe(200);
    expect(crawl.calls[0].urls).toEqual(['https://example.test/entry']);
  });

  it('404s for an unknown source', async () => {
    const { h, operatorHeaders } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      payload: { sourceKey: 'ghost' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('400s when no adapter is registered for the source', async () => {
    const { h, operatorHeaders } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      payload: { sourceKey: 'inmuebles24', urls: ['https://inmuebles24.test/x'] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message: "no adapter registered for source 'inmuebles24'",
        code: 'NO_ADAPTER',
      },
    });
  });

  it('400s when there are no entry URLs at all', async () => {
    const { h, operatorHeaders, crawl } = await harnessWithRuns();
    // Strip the fixture's configured entryUrls: the crawl trigger must never
    // be called without anywhere to start.
    (await h.sources.findByKey('vivanuncios'))!.config = {};

    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      payload: { sourceKey: 'vivanuncios' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        message:
          "no entry URLs: pass 'urls' in the request or configure 'entryUrls' on the source",
        code: 'NO_URLS',
      },
    });
    expect(crawl.calls).toHaveLength(0);
  });

  it('rejects malformed payloads with 400', async () => {
    const { h, operatorHeaders } = await harnessWithRuns();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/crawl-runs',
      headers: operatorHeaders,
      payload: { sourceKey: '', extra: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});