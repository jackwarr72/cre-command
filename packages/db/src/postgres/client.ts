import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** Postgres connection string for the cre-command database. */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://cre:secret@localhost:5432/cre_command';
}

/** Create a pg pool for the cre-command database. */
export function createPool(connectionString: string = databaseUrl()): Pool {
  return new Pool({ connectionString });
}

/** Create a typed Drizzle client bound to the schema. */
export function createDatabase(pool: Pool = createPool()): Database {
  return drizzle(pool, { schema });
}