/**
 * @cre/db
 *
 * PostgreSQL persistence layer for cre-command.
 *
 * Public surface:
 * - Drizzle schema (tables, enums, relations, indexes) and row types
 * - a typed database client factory
 * - `db:migrate` / `db:generate` scripts (see package.json)
 *
 * The schema is derived from `@cre/shared` domain contracts; persistence
 * concerns (FKs, indexes, versioning, raw payloads) stay here.
 */

export * from './postgres/schema';
export { createDatabase, createPool, databaseUrl } from './postgres/client';
export type { Database } from './postgres/client';