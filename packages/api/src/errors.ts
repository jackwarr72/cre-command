import type { ApiErrorBody } from '@cre/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** An error carrying its intended HTTP status and a machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message);
  }

  static notFound(code: string, message: string): ApiError {
    return new ApiError(404, code, message);
  }
}

export function errorBody(message: string, code?: string): ApiErrorBody {
  return { error: { message, ...(code ? { code } : {}) } };
}

/** Node environment of the API process (mirrors `AppDeps['nodeEnv']`). */
export type NodeEnv = 'development' | 'production' | 'test';

/**
 * Maps every failure onto the shared `ApiErrorBody` shape:
 * `ApiError` → its status/code; `ZodError` → 400 validation summary;
 * other pre-500 errors (bad JSON, oversized payload) → their status;
 * anything else → 500. The 500 response is opaque in production
 * (`'Internal server error'`, details only in the log). In development/test
 * it additionally carries the real `error.message` and `error.stack` so
 * local debugging doesn't require reading server logs — never the raw
 * Error object itself.
 */
export function registerErrorHandler(
  app: FastifyInstance,
  opts: { nodeEnv?: NodeEnv } = {},
): void {
  // Safe default: diagnostics only when the environment is explicitly dev/test.
  const nodeEnv = opts.nodeEnv ?? 'production';
  const isDiagnosticEnvironment = nodeEnv === 'development' || nodeEnv === 'test';
  app.setErrorHandler(
    (error: FastifyError | ApiError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof ApiError) {
        return reply.status(error.status).send(errorBody(error.message, error.code));
      }
      if (error instanceof ZodError) {
        const details = error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        return reply
          .status(400)
          .send(errorBody(`invalid request: ${details}`, 'VALIDATION_ERROR'));
      }
            const status =
        'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      if (status < 500) {
        // Preserve the error's machine-readable code when present (e.g.
        // 'RATE_LIMITED' from @fastify/rate-limit). Fall back to BAD_REQUEST
        // for generic Fastify errors that only expose a status code.
        const code = typeof error.code === 'string' ? error.code : 'BAD_REQUEST';
        return reply.status(status).send(errorBody(error.message, code));
      }
      request.log.error(error, 'unhandled request error');
      if (isDiagnosticEnvironment) {
        // Development/test: surface the real failure (message + stack) inside
        // the shared envelope. Only these two fields are exposed — the raw
        // Error object is never serialized to the client.
        const body = errorBody(error.message, 'INTERNAL');
        if (error.stack) body.error.stack = error.stack;
        return reply.status(500).send(body);
      }
      // Production: opaque — details stay in the log only.
      return reply.status(500).send(errorBody('Internal server error', 'INTERNAL'));
    },
  );

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorBody('route not found', 'NOT_FOUND'));
  });
}