/**
 * Sources API endpoints.
 *
 * GET  /api/sources        → SourceDto[]  (all configured sources)
 * PATCH /api/sources/:key  → SourceDto    (update crawl policy)
 *
 * `SourceDto` mirrors `@cre/api`'s port but is defined locally here because
 * the web app only depends on `@cre/shared`, not `@cre/api`.
 */
import { ROBOTS_POLICIES, type RobotsPolicy } from '@cre/shared';

import { apiRequest } from './client';

/** Operator-visible source view: identity + crawl-policy fields. */
export interface SourceDto {
  id: string;
  key: string;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  schedule: string;
  config: Record<string, unknown>;
  crawlAllowed: boolean;
  robotsPolicy: RobotsPolicy;
  rateLimitMs: number;
  maxWorkers: number;
  authenticationRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Fields an operator may change on a source's crawl policy. */
export interface SourcePolicyPatch {
  enabled?: boolean;
  crawlAllowed?: boolean;
  robotsPolicy?: RobotsPolicy;
  rateLimitMs?: number;
  maxWorkers?: number;
}

export const sourcesApi = {
  list: (): Promise<SourceDto[]> =>
    apiRequest('/sources'),

  updatePolicy: (
    key: string,
    patch: SourcePolicyPatch,
  ): Promise<SourceDto> =>
    apiRequest(`/sources/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: patch,
    }),
};

export { ROBOTS_POLICIES };
