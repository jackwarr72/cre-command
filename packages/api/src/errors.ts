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

/**
 * Maps every failure onto the shared `ApiErrorBody` shape:
 * `ApiError` → its status/code; `ZodError` → 400 validation summary;
 * other pre-500 errors (bad JSON, oversized payload) → their status;
 * anything else → opaque 500 (details only in the log).
 */
export function registerErrorHandler(app: FastifyInstance): void {
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
        return reply.status(status).send(errorBody(error.message, 'BAD_REQUEST'));
      }
      request.log.error(error, 'unhandled request error');
      return reply.status(500).send(errorBody('Internal server error', 'INTERNAL'));
    },
  );

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(errorBody('route not found', 'NOT_FOUND'));
  });
}