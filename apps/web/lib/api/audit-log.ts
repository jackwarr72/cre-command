/**
 * Audit-log API endpoint.
 *
 * GET /api/audit-log → Paged<AuditLogEntry>  (operator+ role required)
 *
 * `AuditLogEntry` comes from `@cre/shared` and is already API-shaped
 * (ISO date-time strings), so no local DTO mirror is needed.
 */
import { AUDIT_ACTIONS, type AuditAction, type AuditLogEntry, type Paged } from '@cre/shared';

import { apiRequest } from './client';

export interface AuditLogFilter {
  action?: AuditAction;
  actorUserId?: string;
  /** Inclusive ISO date-time lower bound. */
  from?: string;
  /** Inclusive ISO date-time upper bound. */
  to?: string;
}

export const auditLogApi = {
  list: (filter: AuditLogFilter, page: number, pageSize: number): Promise<Paged<AuditLogEntry>> =>
    apiRequest('/audit-log', {
      query: {
        page,
        pageSize,
        action: filter.action,
        actorUserId: filter.actorUserId,
        from: filter.from,
        to: filter.to,
      },
    }),
};

export { AUDIT_ACTIONS };