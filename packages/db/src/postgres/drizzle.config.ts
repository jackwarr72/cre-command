import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for @cre/db.
 * `schema`/`out` are relative to the workspace root (`packages/db`),
 * which is the cwd when run via `npm run db:generate -w packages/db`.
 * Generation does not require a live database.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/postgres/schema.ts',
  out: './src/postgres/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://cre:secret@localhost:5432/cre_command',
  },
  strict: true,
  verbose: true,
});