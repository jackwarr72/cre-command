'use client';

/**
 * (app) group index — redirects authenticated users to the dashboard.
 *
 * Rendered as a client component so we can use useRouter for an instant
 * client-side redirect without a flash of empty content.
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function AppIndex() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return null;
}
