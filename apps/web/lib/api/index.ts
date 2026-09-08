/**
 * Barrel: re-exports the typed API client for ergonomic imports elsewhere.
 *
 * Usage:
 *   import { authApi, listingsApi, sourcesApi, crawlRunsApi } from '@/lib/api';
 */
export { ApiError, type ApiRequestOptions, type HttpMethod, getAuthToken, apiRequest } from './client';
export { authApi } from './auth';
export { dashboardApi, type DashboardSummary } from './dashboard';
export { listingsApi } from './listings';
export { sourcesApi, type SourceDto, type SourcePolicyPatch } from './sources';
export { crawlRunsApi, type CrawlOutcome, type CrawlRunFilter, type TriggerCrawlRequest } from './crawl-runs';
export { auditLogApi, AUDIT_ACTIONS, type AuditLogFilter } from './audit-log';
