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