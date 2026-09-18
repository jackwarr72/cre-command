import { describe, expect, it } from 'vitest';

import { buildTestHarness, createUser, login, makeSourceRow } from './fakes';

function sourceFixtures() {
  const vivanuncios = makeSourceRow({
    key: 'vivanuncios',
    name: 'Vivanuncios',
    robotsPolicy: 'honor',
    rateLimitMs: 800,
    maxWorkers: 2,
  });
  const inmuebles24 = makeSourceRow({
    key: 'inmuebles24',
    name: 'Inmuebles24',
    robotsPolicy: 'strict',
  });
  return { vivanuncios, inmuebles24 };
}

async function harnessWithSources() {
  const { vivanuncios, inmuebles24 } = sourceFixtures();
  const h = await buildTestHarness({ sources: [vivanuncios, inmuebles24] });
  await createUser(h.users, { email: 'operator@cre.test', role: 'operator' });
  await createUser(h.users, { email: 'viewer@cre.test', role: 'viewer' });
  const operatorToken = await login(h.app, 'operator@cre.test');
  const viewerToken = await login(h.app, 'viewer@cre.test');
  return { h, vivanuncios, operatorHeaders: { authorization: `Bearer ${operatorToken}` }, viewerHeaders: { authorization: `Bearer ${viewerToken}` } };
}

describe('GET /api/sources', () => {
  it('requires authentication', async () => {
    const { h } = await harnessWithSources();
    const response = await h.app.inject({ method: 'GET', url: '/api/sources' });
    expect(response.statusCode).toBe(401);
  });

  it('lists sources with the operator-visible policy fields', async () => {
    const { h, operatorHeaders, vivanuncios } = await harnessWithSources();
    const response = await h.app.inject({ method: 'GET', url: '/api/sources', headers: operatorHeaders });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].key).toBe('inmuebles24'); // sorted by key
    const viv = body.find((source: { key: string }) => source.key === 'vivanuncios');
    expect(viv).toMatchObject({
      id: vivanuncios.id,
      name: 'Vivanuncios',
      enabled: true,
      crawlAllowed: true,
      robotsPolicy: 'honor',
      rateLimitMs: 800,
      maxWorkers: 2,
      authenticationRequired: false,
      schedule: '0 3 * * *',
    });
    // Row internals never leak.
    expect(viv.passwordHash).toBeUndefined();
  });
});

describe('PATCH /api/sources/:key', () => {
  it('lets an operator change crawl policy and returns the updated source', async () => {
    const { h, operatorHeaders, vivanuncios } = await harnessWithSources();
    const response = await h.app.inject({
      method: 'PATCH',
      url: '/api/sources/vivanuncios',
      headers: operatorHeaders,
      payload: { enabled: false, robotsPolicy: 'strict', rateLimitMs: 1200 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      key: 'vivanuncios',
      enabled: false,
      robotsPolicy: 'strict',
      rateLimitMs: 1200,
      // Untouched policy fields stay as they were.
      crawlAllowed: true,
      maxWorkers: 2,
    });
    const stored = (await h.sources.findByKey('vivanuncios'))!;
    expect(stored.enabled).toBe(false);
    expect(stored.id).toBe(vivanuncios.id);
  });

  it('forbids viewers (403) and unauthenticated requests (401)', async () => {
    const { h, viewerHeaders } = await harnessWithSources();

    const viewer = await h.app.inject({
      method: 'PATCH',
      url: '/api/sources/vivanuncios',
      headers: viewerHeaders,
      payload: { enabled: false },
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.code).toBe('FORBIDDEN');

    const anonymous = await h.app.inject({
      method: 'PATCH',
      url: '/api/sources/vivanuncios',
      payload: { enabled: false },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('rejects invalid policy values with 400', async () => {
    const { h, operatorHeaders } = await harnessWithSources();

    const badPolicy = await h.app.inject({
      method: 'PATCH',
      url: '/api/sources/vivanuncios',
      headers: operatorHeaders,
      payload: { robotsPolicy: 'ignore-robots' },
    });
    expect(badPolicy.statusCode).toBe(400);
    expect(badPolicy.json().error.code).toBe('VALIDATION_ERROR');

    const negative = await h.app.inject({
      method: 'PATCH',
      url: '/api/sources/vivanuncios',
      headers: operatorHeaders,
      payload: { rateLimitMs: -5 },
    });
    expect(negative.statusCode).toBe(400);

    const unknownField = await h.app.inject({
      method: 'PATCH',
      url: '/api/sources/vivanuncios',
      headers: operatorHeaders,
      payload: { passwordHash: 'nope' },
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it('404s for an unknown source key', async () => {
    const { h, operatorHeaders } = await harnessWithSources();
    const response = await h.app.inject({
      method: 'PATCH',
      url: '/api/sources/nope',
      headers: operatorHeaders,
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { message: "no source with key 'nope'", code: 'NOT_FOUND' },
    });
  });
});

describe('POST /api/sources', () => {
  const validPayload = {
    key: 'zonaprop',
    name: 'ZonaProp',
    baseUrl: 'https://www.zonaprop.com.ar',
    schedule: '0 4 * * *',
    robotsPolicy: 'strict',
    rateLimitMs: 750,
    maxWorkers: 3,
  };

  it('requires authentication (401) and forbids viewers (403)', async () => {
    const { h, viewerHeaders } = await harnessWithSources();

    const anonymous = await h.app.inject({ method: 'POST', url: '/api/sources', payload: validPayload });
    expect(anonymous.statusCode).toBe(401);

    const viewer = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: viewerHeaders,
      payload: validPayload,
    });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.code).toBe('FORBIDDEN');
  });

  it('creates a source, persists it, and applies schema defaults', async () => {
    const { h, operatorHeaders } = await harnessWithSources();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: operatorHeaders,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      key: 'zonaprop',
      name: 'ZonaProp',
      baseUrl: 'https://www.zonaprop.com.ar',
      schedule: '0 4 * * *',
      robotsPolicy: 'strict',
      rateLimitMs: 750,
      maxWorkers: 3,
      // Not accepted on create — schema/DB defaults apply.
      enabled: true,
      crawlAllowed: true,
      authenticationRequired: false,
      config: {},
    });

    const stored = await h.sources.findByKey('zonaprop');
    expect(stored).toMatchObject({
      key: 'zonaprop',
      name: 'ZonaProp',
      baseUrl: 'https://www.zonaprop.com.ar',
      schedule: '0 4 * * *',
      robotsPolicy: 'strict',
      rateLimitMs: 750,
      maxWorkers: 3,
    });
  });

  it('accepts underscore keys like vivanuncios_metepec', async () => {
    const { h, operatorHeaders } = await harnessWithSources();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: operatorHeaders,
      payload: {
        key: 'vivanuncios_metepec',
        name: 'Vivanuncios Metepec',
        baseUrl: 'https://www.vivanuncios.com.mx',
        schedule: '0 3 * * *',
        robotsPolicy: 'strict',
        rateLimitMs: 500,
        maxWorkers: 1,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      key: 'vivanuncios_metepec',
      name: 'Vivanuncios Metepec',
    });
    expect(await h.sources.findByKey('vivanuncios_metepec')).not.toBeNull();
  });

  it('treats an omitted, null, or empty baseUrl as null', async () => {
    const { h, operatorHeaders } = await harnessWithSources();

    const omitted = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: operatorHeaders,
      payload: {
        key: 'no-url',
        name: 'No URL',
        schedule: '0 3 * * *',
        robotsPolicy: 'honor',
        rateLimitMs: 500,
        maxWorkers: 1,
      },
    });
    expect(omitted.statusCode).toBe(200);
    expect(omitted.json().baseUrl).toBeNull();

    const nulled = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: operatorHeaders,
      payload: {
        key: 'null-url',
        name: 'Null URL',
        baseUrl: null,
        schedule: '0 3 * * *',
        robotsPolicy: 'honor',
        rateLimitMs: 500,
        maxWorkers: 1,
      },
    });
    expect(nulled.statusCode).toBe(200);
    expect(nulled.json().baseUrl).toBeNull();

    const empty = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: operatorHeaders,
      payload: {
        key: 'empty-url',
        name: 'Empty URL',
        baseUrl: '   ',
        schedule: '0 3 * * *',
        robotsPolicy: 'honor',
        rateLimitMs: 500,
        maxWorkers: 1,
      },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().baseUrl).toBeNull();
  });

  it('rejects a duplicate key with 409 DUPLICATE_KEY', async () => {
    const { h, operatorHeaders } = await harnessWithSources();
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: operatorHeaders,
      payload: { ...validPayload, key: 'vivanuncios' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DUPLICATE_KEY');
    // The pre-existing source is untouched.
    expect(await h.sources.findByKey('vivanuncios')).not.toBeNull();
  });

  it('rejects invalid payloads with 400 VALIDATION_ERROR', async () => {
    const { h, operatorHeaders } = await harnessWithSources();

    const invalid: Record<string, unknown>[] = [
      { ...validPayload, key: 'Vivanuncios' },            // uppercase key
      { ...validPayload, key: '-leading' },               // must start alphanumeric
      { ...validPayload, key: '' },                       // empty key
      { ...validPayload, name: '' },                      // empty name
      { ...validPayload, baseUrl: 'not-a-url' },          // not a URL
      { ...validPayload, baseUrl: 'ftp://example.test' }, // not http(s)
      { ...validPayload, schedule: 'once a day' },        // not cron-shaped
      { ...validPayload, robotsPolicy: 'ignore-robots' }, // unknown policy
      { ...validPayload, rateLimitMs: -5 },               // negative rate limit
      { ...validPayload, maxWorkers: 0 },                 // zero workers
      { ...validPayload, maxWorkers: 1.5 },               // non-integer
      { ...validPayload, extra: 'field' },                // unknown field (strict)
    ];
    for (const payload of invalid) {
      const response = await h.app.inject({
        method: 'POST',
        url: '/api/sources',
        headers: operatorHeaders,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    // Nothing was created by the invalid attempts.
    expect(await h.sources.findByKey('zonaprop')).toBeNull();
  });

  it('appends a source.created audit entry', async () => {
    const { h, operatorHeaders } = await harnessWithSources();
    await h.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: operatorHeaders,
      payload: validPayload,
    });
    const entry = h.audit.rows.find((row) => row.action === 'source.created');
    expect(entry).toMatchObject({ targetType: 'source', targetId: 'zonaprop' });
  });
});