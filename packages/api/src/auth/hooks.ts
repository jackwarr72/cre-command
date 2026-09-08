import type { User, UserRole } from '@cre/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '../errors';
import type { SessionRepo } from '../ports';
import { toUserDto } from '../serializers';
import { hashToken } from './tokens';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth guards once the Bearer token is resolved. */
    user?: User | null;
    /** Set when AUTH_BYPASS=true + NODE_ENV=development */
    developmentUser?: User | null;
  }
}

/** Returns a fixed development user when AUTH_BYPASS is enabled. */
function developmentUser(): User {
  return {
    id: 'usr-6',
    email: 'operator@cre.test',
    role: 'admin' as UserRole,
  };
}

const BEARER_PREFIX = 'Bearer ';

/** Extracts the raw bearer token from the Authorization header, when present. */
export function bearerTokenOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === '' ? null : token;
}

/** Decorates requests so handlers can read `request.user` (set by the guards). */
export function decorateRequestUser(app: FastifyInstance): void {
  app.decorateRequest('user', null);
}

export interface AuthGuards {
  /** 401 unless a valid, unexpired bearer session is presented. */
  requireAuth: (request: FastifyRequest) => Promise<void>;
  /** 401/403 unless the session user has one of the given roles. */
  requireRole: (...roles: UserRole[]) => (request: FastifyRequest) => Promise<void>;
}

/**
 * Builds the route guards. Guards resolve the session themselves (no global
 * hook), so route-level `preHandler`s have no ordering dependencies.
 *
 * When AUTH_BYPASS is enabled in development mode, all authenticated routes
 * inject a fixed development operator/admin identity instead of requiring
 * a valid session.
 */
export function createAuthGuards(
  sessions: SessionRepo,
  now?: () => Date,
  authBypass = false,
  nodeEnv = 'development',
): AuthGuards {
  const clock = now ?? ((): Date => new Date());
  const isBypass = authBypass && nodeEnv === 'development';
async function resolveUser(request: FastifyRequest): Promise<User | null> {
    if (isBypass) {
      const user = developmentUser();
      request.user = user;
      return user;
    }
    const token = bearerTokenOf(request);
    if (!token) {
      request.user = null;
      return null;
    }
    const session = await sessions.findActive(hashToken(token), clock());
    const user = session ? toUserDto(session.user) : null;
    request.user = user;
    return user;
  }
  async function requireAuth(request: FastifyRequest): Promise<void> {
    const user = await resolveUser(request);
    if (!user) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'authentication required');
    }
  }

  function requireRole(...roles: UserRole[]): (request: FastifyRequest) => Promise<void> {
    return async (request) => {
      const user = await resolveUser(request);
      if (!user) {
        throw new ApiError(401, 'UNAUTHENTICATED', 'authentication required');
      }
      if (!roles.includes(user.role)) {
        throw new ApiError(403, 'FORBIDDEN', `requires role: ${roles.join(' or ')}`);
      }
      request.user = user;
    };
  }

  return { requireAuth, requireRole };
}