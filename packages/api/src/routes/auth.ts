import type { LoginResponse } from '@cre/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { bearerTokenOf, createAuthGuards } from '../auth/hooks';
import { verifyPassword } from '../auth/passwords';
import { hashToken, newSessionToken } from '../auth/tokens';
import { ApiError } from '../errors';
import type { AppDeps } from '../ports';
import { toUserDto } from '../serializers';

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);
  const ttlMs = (deps.sessionTtlHours ?? 168) * 3_600_000;
  const now = deps.now ?? ((): Date => new Date());

  // Credential endpoints get a stricter per-IP cap than the global limit:
  // brute-forcing passwords must hit a wall long before ordinary API traffic.
  const loginRateLimitMax = deps.security?.loginRateLimitMax ?? 10;
  const rateLimitWindowMs = deps.security?.rateLimitWindowMs ?? 60_000;

  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: loginRateLimitMax,
          timeWindow: rateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = loginSchema.parse(request.body);
      const user = await deps.users.findByEmail(email.trim().toLowerCase());
      if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
        // One message for unknown email / wrong password / disabled account —
        // never reveal which one failed.
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid email or password');
      }

      const at = now();
      const { token, tokenHash } = newSessionToken();
      const expiresAt = new Date(at.getTime() + ttlMs);
      await deps.sessions.create({ userId: user.id, tokenHash, expiresAt }, at);

      const response: LoginResponse = {
        user: toUserDto(user),
        token,
        expiresAt: expiresAt.toISOString(),
      };
      return reply.status(200).send(response);
    },
  );

  app.get('/auth/me', { preHandler: guards.requireAuth }, async (request) => request.user);

  app.post('/auth/logout', { preHandler: guards.requireAuth }, async (request, reply) => {
    const token = bearerTokenOf(request);
    if (token) {
      await deps.sessions.deleteByTokenHash(hashToken(token));
    }
    return reply.status(204).send();
  });
}