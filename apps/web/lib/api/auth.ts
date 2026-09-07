/**
 * Auth API endpoints.
 *
 * POST /api/auth/login   → { user, token, expiresAt }
 * GET  /api/auth/me      → User (current session user)
 * POST /api/auth/logout   → 204 (deletes server-side session)
 *
 * Token persistence is handled by `lib/auth/token-store.ts`.
 */
import type { LoginRequest, LoginResponse, User } from '@cre/shared';

import { apiRequest } from './client';

export const authApi = {
  login: (credentials: LoginRequest): Promise<LoginResponse> =>
    apiRequest('/auth/login', { method: 'POST', body: credentials }),

  logout: (): Promise<void> =>
    apiRequest('/auth/logout', { method: 'POST' }),

  getCurrentUser: (): Promise<User> =>
    apiRequest('/auth/me'),
};
