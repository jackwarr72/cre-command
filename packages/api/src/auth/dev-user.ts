import type { User } from '@cre/shared';

/** Fixed development user used when AUTH_BYPASS is enabled in development mode. */
export const developmentUser = (): User => ({
  id: 'usr-6',
  email: 'operator@cre.test',
  role: 'admin',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});