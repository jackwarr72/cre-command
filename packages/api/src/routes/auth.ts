import type { LoginRequest, LoginResponse } from '@cre/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { bearerTokenOf, createAuthGuards } from '../auth/hooks';
import { verifyPassword } from '../auth/passwords';
import { hashToken, newSessionToken } from '../auth/tokens';
import { verifyTotp } from '../auth/totp';
import { verifyRecoveryCode } from '../auth/mfa-crypto';
import { ApiError } from '../errors';
import type { AppDeps } from '../ports';
import { toUserDto } from '../serializers';
import { DEFAULT_MFA_CHALLENGE_TTL_MS } from '../config';

const loginSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
    mfaCode: z
      .string()
      .regex(/^\d{6}$/, 'mfaCode must be a 6-digit string')
      .optional(),
    mfaRecoveryCode: z
      .string()
      .regex(/^[A-Z0-9]{10}$/, 'mfaRecoveryCode must be a 10-character alphanumeric string')
      .optional(),
    mfaChallengeId: z.string().min(1).max(128).optional(),
    deviceFingerprint: z.string().min(1).max(128).optional(),
  })
  .strict();

function mfaChallengeTtl(deps: AppDeps): number {
  return deps.mfaChallengeTtlMs ?? DEFAULT_MFA_CHALLENGE_TTL_MS;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const guards = createAuthGuards(deps.sessions, deps.now);
  const ttlMs = (deps.sessionTtlHours ?? 168) * 3_600_000;
  const now = deps.now ?? ((): Date => new Date());

  const loginRateLimitMax = deps.security?.loginRateLimitMax ?? 10;
  const rateLimitWindowMs = deps.security?.rateLimitWindowMs ?? 60_000;
  const mfaVerifyRateLimitMax = deps.security?.mfaVerifyRateLimitMax ?? 5;
  const mfaVerifyRateLimitWindowMs = deps.security?.mfaVerifyRateLimitWindowMs ?? 60_000;

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
      const body = loginSchema.parse(request.body);
      const email = body.email.trim().toLowerCase();
      const user = await deps.users.findByEmail(email);
      if (!user || !user.active || !(await verifyPassword(body.password, user.passwordHash))) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid email or password');
      }

      const mfa = await deps.users.findMfaConfig(user.id);
      if (mfa.mfaEnabled) {
        const { mfaCode, mfaRecoveryCode, mfaChallengeId } = body;
        const challengeTtl = mfaChallengeTtl(deps);

        if (!mfaCode && !mfaRecoveryCode) {
          const at = now();
          const expiresAt = new Date(at.getTime() + challengeTtl);
          const mfaChallengeIdNew = await deps.mfaChallenges.create(
            { userId: user.id, expiresAt },
            at,
          );
          const challenge: LoginResponse = {
            user: toUserDto(user),
            token: '',
            expiresAt: new Date(0).toISOString(),
            mfaRequired: true,
            mfaChallengeId: mfaChallengeIdNew,
            mfaChallengeTtlSeconds: Math.floor(challengeTtl / 1000),
          };
          return reply.status(200).send(challenge);
        }

        if (!mfaChallengeId) {
          throw new ApiError(
            400,
            'MFA_CHALLENGE_REQUIRED',
            'mfaCode or mfaRecoveryCode supplied without a corresponding mfaChallengeId',
          );
        }

        const at = now();
        const consumed = await deps.mfaChallenges.consume(mfaChallengeId, at);
        if (!consumed || consumed.userId !== user.id) {
          throw new ApiError(401, 'INVALID_MFA_CHALLENGE', 'MFA challenge is invalid or expired');
        }

        let verified = false;

        if (mfaCode && mfa.mfaSecret) {
          if (verifyTotp(mfa.mfaSecret, mfaCode, at)) {
            verified = true;
          }
        }

        if (!verified && mfaRecoveryCode && mfa.mfaRecoveryCodes && mfa.mfaRecoveryCodes.length > 0) {
          const result = await verifyRecoveryCode(mfaRecoveryCode, mfa.mfaRecoveryCodes);
          if (result.valid) {
            verified = true;
            await deps.users.updateMfaRecoveryCodes(user.id, result.remainingCodes);
          }
        }

        if (!verified) {
          throw new ApiError(401, 'INVALID_MFA_CODE', 'invalid MFA code or recovery code');
        }
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

  app.post(
    '/auth/login/mfa-verify',
    {
      config: {
        rateLimit: {
          max: mfaVerifyRateLimitMax,
          timeWindow: mfaVerifyRateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      const body = loginSchema.pick({ email: true, password: true, mfaCode: true, mfaRecoveryCode: true, mfaChallengeId: true }).parse(request.body);
      const email = body.email.trim().toLowerCase();
      const user = await deps.users.findByEmail(email);
      if (!user || !user.active || !(await verifyPassword(body.password, user.passwordHash))) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'invalid email or password');
      }

      const mfa = await deps.users.findMfaConfig(user.id);
      if (!mfa.mfaEnabled) {
        throw new ApiError(400, 'MFA_NOT_ENABLED', 'MFA is not enabled for this user');
      }

      const { mfaCode, mfaRecoveryCode, mfaChallengeId } = body;
      if (!mfaCode && !mfaRecoveryCode) {
        throw new ApiError(400, 'MFA_CODE_REQUIRED', 'mfaCode or mfaRecoveryCode is required');
      }

      if (!mfaChallengeId) {
        throw new ApiError(400, 'MFA_CHALLENGE_REQUIRED', 'mfaChallengeId is required');
      }

      const at = now();
      const consumed = await deps.mfaChallenges.consume(mfaChallengeId, at);
      if (!consumed || consumed.userId !== user.id) {
        throw new ApiError(401, 'INVALID_MFA_CHALLENGE', 'MFA challenge is invalid or expired');
      }

      let verified = false;

      if (mfaCode && mfa.mfaSecret) {
        if (verifyTotp(mfa.mfaSecret, mfaCode, at)) {
          verified = true;
        }
      }

      if (!verified && mfaRecoveryCode && mfa.mfaRecoveryCodes && mfa.mfaRecoveryCodes.length > 0) {
        const result = await verifyRecoveryCode(mfaRecoveryCode, mfa.mfaRecoveryCodes);
        if (result.valid) {
          verified = true;
          await deps.users.updateMfaRecoveryCodes(user.id, result.remainingCodes);
        }
      }

      if (!verified) {
        throw new ApiError(401, 'INVALID_MFA_CODE', 'invalid MFA code or recovery code');
      }

      const ttl = (deps.sessionTtlHours ?? 168) * 3_600_000;
      const { token, tokenHash } = newSessionToken();
      const expiresAt = new Date(at.getTime() + ttl);
      await deps.sessions.create({ userId: user.id, tokenHash, expiresAt }, at);

      return reply.status(200).send({
        user: toUserDto(user),
        token,
        expiresAt: expiresAt.toISOString(),
      });
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

/** Re-exported for tests that need the shared login schema shape. */
export const loginBodySchema = loginSchema;
export type { LoginRequest };
