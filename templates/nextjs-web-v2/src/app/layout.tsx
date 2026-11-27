/**
 * FEATURE:    The app shell.
 * USER STORY: As a user I want every page of this app to share one title and language.
 * ARCHITECTURE: Server component, no data access. Pages live next to it under src/app/.
 */
import type { ReactNode } from 'react';

export const metadata = { title: 'Orders' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem' }}>{children}</body>
    </html>
  );
}
