import type { LoginRequest, LoginResponse } from '@cre/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { bearerTokenOf, createAuthGuards } from '../auth/hooks';
import { verifyPassword } from '../auth/passwords';
import { hashToken, newSessionToken } from '../auth/tokens';
import { generateTotpSecret, otpauthTotpUrl, verifyTotp } from '../auth/totp';
import {
  encryptMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCodes,
  verifyRecoveryCode,
} from '../auth/mfa-crypto';
import { ApiError } from '../errors';
import type { AppDeps } from '../ports';
import { toUserDto } from '../serializers';
import { DEFAULT_MFA_CHALLENGE_TTL_MS } from '../config';

/** How the second factor (or none) satisfied the login. */
type LoginMethod = 'password' | 'totp' | 'recovery_code' | 'bypass';

/** Returns a fixed development user when AUTH_BYPASS is enabled. */
function developmentUser() {
  return {
    id: 'development-user',
    email: 'admin@cre.local',
    role: 'admin' as const,
  };
}

/**
 * Fire-and-record an audit event: a failed audit write must never break the
 * operation being audited, so append errors are logged and swallowed.
 */
function recordAudit(
  deps: AppDeps,
  request: { log: { error: (obj: unknown, msg: string) => void } },
  event: Parameters<AppDeps['audit']['append']>[0],
): Promise<void> {
  return deps.audit.append(event).catch((error: unknown) => {
    request.log.error({ error }, 'audit append failed');
  });
}

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
  const guards = createAuthGuards(
    deps.sessions,
    deps.now,
    deps.authBypass ?? false,
    deps.nodeEnv ?? 'development',
  );
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

      // AUTH_BYPASS mode: return a fixed development admin identity
      // without checking credentials. Only enabled in development.
      if (deps.authBypass && deps.nodeEnv === 'development') {
        const devUser = developmentUser();
        const at = now();
        const { token, tokenHash } = newSessionToken();
        const expiresAt = new Date(at.getTime() + ttlMs);
        await deps.sessions.create({ userId: devUser.id, tokenHash, expiresAt }, at);
        await recordAudit(deps, request, {
          action: 'auth.login.success',
          at,
          actorUserId: devUser.id,
          actorEmail: devUser.email,
          metadata: { method: 'bypass' },
        });
        const response: LoginResponse = {
          user: toUserDto(devUser),
          token,
          expiresAt: expiresAt.toISOString(),
        };
        return reply.status(200).send(response);
      }

      let authMethod: LoginMethod = 'password';
      const user = await deps.users.findByEmail(email);
      if (!user || !user.active || !(await verifyPassword(body.password, user.passwordHash))) {
        // Pre-auth event: no actor id, only the attempted email snapshot.
        await recordAudit(deps, request, {
          action: 'auth.login.failed',
          at: now(),
          actorEmail: email,
          metadata: { reason: 'invalid_credentials' },
        });
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
          await recordAudit(deps, request, {
            action: 'auth.login.failed',
            at,
            actorUserId: user.id,
            actorEmail: user.email,
            metadata: { reason: 'invalid_mfa_challenge' },
          });
          throw new ApiError(401, 'INVALID_MFA_CHALLENGE', 'MFA challenge is invalid or expired');
        }

        let verified = false;
        let authMethod: LoginMethod = 'totp';

        if (mfaCode && mfa.mfaSecret) {
          if (verifyTotp(mfa.mfaSecret, mfaCode, at)) {
            verified = true;
          }
        }

        if (!verified && mfaRecoveryCode && mfa.mfaRecoveryCodes && mfa.mfaRecoveryCodes.length > 0) {
          const result = await verifyRecoveryCode(mfaRecoveryCode, mfa.mfaRecoveryCodes);
          if (result.valid) {
            verified = true;
            authMethod = 'recovery_code';
            await deps.users.updateMfaRecoveryCodes(user.id, result.remainingCodes);
            await recordAudit(deps, request, {
              action: 'auth.mfa.recovery_code_used',
              at,
              actorUserId: user.id,
              actorEmail: user.email,
              targetType: 'user',
              targetId: user.id,
              metadata: { remainingCodes: result.remainingCodes.length },
            });
          }
        }

        if (!verified) {
          await recordAudit(deps, request, {
            action: 'auth.login.failed',
            at,
            actorUserId: user.id,
            actorEmail: user.email,
            metadata: { reason: 'invalid_mfa_code' },
          });
          throw new ApiError(401, 'INVALID_MFA_CODE', 'invalid MFA code or recovery code');
        }
      }

      const at = now();
      const { token, tokenHash } = newSessionToken();
      const expiresAt = new Date(at.getTime() + ttlMs);
      await deps.sessions.create({ userId: user.id, tokenHash, expiresAt }, at);

      await recordAudit(deps, request, {
        action: 'auth.login.success',
        at,
        actorUserId: user.id,
        actorEmail: user.email,
        metadata: { method: authMethod },
      });

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
      let authMethod: LoginMethod = 'totp';
      const user = await deps.users.findByEmail(email);
      if (!user || !user.active || !(await verifyPassword(body.password, user.passwordHash))) {
        await recordAudit(deps, request, {
          action: 'auth.login.failed',
          at: now(),
          actorEmail: email,
          metadata: { reason: 'invalid_credentials' },
        });
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
        await recordAudit(deps, request, {
          action: 'auth.login.failed',
          at,
          actorUserId: user.id,
          actorEmail: user.email,
          metadata: { reason: 'invalid_mfa_challenge' },
        });
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
          authMethod = 'recovery_code';
          await deps.users.updateMfaRecoveryCodes(user.id, result.remainingCodes);
          await recordAudit(deps, request, {
            action: 'auth.mfa.recovery_code_used',
            at,
            actorUserId: user.id,
            actorEmail: user.email,
            targetType: 'user',
            targetId: user.id,
            metadata: { remainingCodes: result.remainingCodes.length },
          });
        }
      }

      if (!verified) {
        await recordAudit(deps, request, {
          action: 'auth.login.failed',
          at,
          actorUserId: user.id,
          actorEmail: user.email,
          metadata: { reason: 'invalid_mfa_code' },
        });
        throw new ApiError(401, 'INVALID_MFA_CODE', 'invalid MFA code or recovery code');
      }

      const ttl = (deps.sessionTtlHours ?? 168) * 3_600_000;
      const { token, tokenHash } = newSessionToken();
      const expiresAt = new Date(at.getTime() + ttl);
      await deps.sessions.create({ userId: user.id, tokenHash, expiresAt }, at);

      await recordAudit(deps, request, {
        action: 'auth.login.success',
        at,
        actorUserId: user.id,
        actorEmail: user.email,
        metadata: { method: authMethod },
      });

      return reply.status(200).send({
        user: toUserDto(user),
        token,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  // ── MFA enrollment (DB-backed, two-step) ────────────────────────
  // Step 1 stores an encrypted pending secret; step 2 verifies a TOTP code
  // against it and atomically activates MFA plus provisions recovery codes.
  // Both endpoints require an authenticated session (self-service).

  // Enrollment is a bodyless action endpoint — accept an empty (or absent)
  // body, but strictly reject any unknown fields.
  const mfaEnrollSchema = z.object({}).strict().optional();
  const mfaConfirmSchema = z
    .object({
      code: z.string().regex(/^\d{6}$/, 'code must be a 6-digit string'),
    })
    .strict();

  app.post(
    '/auth/mfa/enroll',
    { preHandler: guards.requireAuth },
    async (request, reply) => {
      mfaEnrollSchema.parse(request.body);
      const user = request.user!;
      const mfa = await deps.users.findMfaConfig(user.id);
      if (mfa.mfaEnabled) {
        throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled for this user');
      }

      const secret = generateTotpSecret();
      let encrypted: { encrypted: string; iv: string };
      try {
        encrypted = encryptMfaSecret(secret);
      } catch {
        throw new ApiError(
          500,
          'MFA_NOT_CONFIGURED',
          'MFA_ENCRYPTION_KEY is required to enroll MFA (32 bytes, base64-encoded)',
        );
      }

      await deps.users.saveMfaEnrollmentSecret(
        user.id,
        { mfaSecretEncrypted: encrypted.encrypted, mfaSecretIv: encrypted.iv },
        now(),
      );

      await recordAudit(deps, request, {
        action: 'auth.mfa.enrollment_started',
        at: now(),
        actorUserId: user.id,
        actorEmail: user.email,
        targetType: 'user',
        targetId: user.id,
      });

      return reply.status(200).send({
        secret,
        otpauthUrl: otpauthTotpUrl({
          secret,
          accountName: user.email,
          issuer: 'cre-command',
        }),
      });
    },
  );

  app.post(
    '/auth/mfa/confirm',
    {
      preHandler: guards.requireAuth,
      config: {
        rateLimit: {
          max: mfaVerifyRateLimitMax,
          timeWindow: mfaVerifyRateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      const body = mfaConfirmSchema.parse(request.body);
      const user = request.user!;
      const at = now();
      const mfa = await deps.users.findMfaConfig(user.id);
      if (mfa.mfaEnabled) {
        throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'MFA is already enabled for this user');
      }
      if (!mfa.mfaSecret) {
        throw new ApiError(
          400,
          'MFA_NOT_ENROLLED',
          'start MFA enrollment with POST /auth/mfa/enroll before confirming',
        );
      }
      if (!verifyTotp(mfa.mfaSecret, body.code, at)) {
        throw new ApiError(401, 'INVALID_MFA_CODE', 'invalid MFA code');
      }

      const recoveryCodes = generateRecoveryCodes();
      const hashedRecoveryCodes = await hashRecoveryCodes(recoveryCodes);
      const encrypted = encryptMfaSecret(mfa.mfaSecret);
      await deps.users.activateMfa(
        user.id,
        {
          mfaSecretEncrypted: encrypted.encrypted,
          mfaSecretIv: encrypted.iv,
          hashedRecoveryCodes,
          mfaVerifiedAt: at,
        },
        at,
      );

      await recordAudit(deps, request, {
        action: 'auth.mfa.enabled',
        at,
        actorUserId: user.id,
        actorEmail: user.email,
        targetType: 'user',
        targetId: user.id,
      });

      return reply.status(200).send({
        user: request.user,
        recoveryCodes,
      });
    },
  );

  app.get('/auth/me', { preHandler: guards.requireAuth }, async (request) => {
    return request.user;
  });

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
