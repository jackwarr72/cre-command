import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import * as schema from './schema';

/**
 * Apply pending SQL migrations.
 *
 *   DATABASE_URL=postgres://... npm run db:migrate -w packages/db
 *
 * Defaults to the local dev database when DATABASE_URL is unset.
 */
async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://cre:secret@localhost:5432/cre_command';

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  console.log('Applying migrations …');
  await migrate(db, { migrationsFolder: './src/postgres/migrations' });
  console.log('Migrations applied.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});