'use client';

/**
 * App-shell layout for authenticated routes.
 *
 * Guards:
 *   - While the session is being resolved → spinner.
 *   - If no session → the parent effect redirects to /login.
 *
 * Authenticated users get the Sidebar + scrollable main region.
 */
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useAuth } from '@/lib/auth/auth-context';
import { Sidebar } from '@/components/layout/sidebar';
import { Spinner } from '@/components/ui/spinner';

export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-noir-900">
        <Spinner className="size-6" />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-noir-900">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
