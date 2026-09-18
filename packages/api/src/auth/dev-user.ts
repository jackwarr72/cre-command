import type { User } from '@cre/shared';

/**
 * Fixed development user used when AUTH_BYPASS is enabled in development mode.
 *
 * `id` must be a syntactically valid UUID: dev-bypass requests write it into
 * UUID/FK columns (e.g. `crawl_runs.requested_by_user_id`), and Postgres
 * rejects the string form `usr-6` with 22P03 — turning every operator action
 * into an opaque 500. The value need not exist in `users`; it only has to
 * satisfy the column type.
 */
export const developmentUser = (): User => ({
  id: '00000000-0000-4000-8000-000000000006',
  email: 'operator@cre.test',
  role: 'admin',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});