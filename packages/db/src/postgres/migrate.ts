import { fileURLToPath } from 'node:url';

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
  // Module-relative (not cwd-relative): resolves correctly whether run from the
  // workspace root, `packages/db`, or inside the container.
  const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));
  await migrate(db, { migrationsFolder });
  console.log('Migrations applied.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});