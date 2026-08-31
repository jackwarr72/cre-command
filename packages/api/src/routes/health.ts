import type { FastifyInstance } from 'fastify';

/** Liveness probe — deliberately unauthenticated. */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async () => ({ ok: true }));
}