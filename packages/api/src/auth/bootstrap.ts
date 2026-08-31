import type { UserRepo } from '../ports';
import { hashPassword } from './passwords';

export interface BootstrapAdminOptions {
  email?: string | undefined;
  password?: string | undefined;
}

/**
 * Creates the initial admin account exactly once: only when bootstrap
 * credentials are configured (CRE_ADMIN_EMAIL/CRE_ADMIN_PASSWORD) and the
 * users table is still empty. Deliberately a no-op otherwise — operators are
 * managed through the database, never auto-provisioned behind the caller's back.
 */
export async function ensureBootstrapAdmin(
  users: UserRepo,
  options: BootstrapAdminOptions,
  now: Date = new Date(),
): Promise<{ created: boolean; email?: string }> {
  const { email, password } = options;
  if (!email || !password) return { created: false };
  if ((await users.count()) > 0) return { created: false };

  const user = await users.create(
    {
      email: email.trim().toLowerCase(),
      role: 'admin',
      passwordHash: await hashPassword(password),
    },
    now,
  );
  return { created: true, email: user.email };
}