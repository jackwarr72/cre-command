import type { ReactNode } from 'react';

import { AuthProvider } from '@/lib/auth/auth-context';
import './globals.css';

export const metadata = {
  title: 'cre-command — Control Panel',
  description:
    'Commercial Real Estate intelligence, crawling & lead-generation control panel',
};

/**
 * Root layout. Mounts the AuthProvider (client component) around every route
 * so that the entire app tree has access to auth state.
 *
 * Server-rendered metadata and font optimization are available here; the
 * auth lifecycle is client-only (localStorage token store).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
