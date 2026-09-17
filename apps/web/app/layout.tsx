import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { AuthProvider } from '@/lib/auth/auth-context';
import './globals.css';

export const metadata = {
  title: 'cre-command — Control Panel',
  description:
    'Commercial Real Estate intelligence, crawling & lead-generation control panel',
};

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        shouldRetryOnError: false,
        revalidateOnFocus: false,
      }}
    >
      <AuthProvider>{children}</AuthProvider>
    </SWRConfig>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}