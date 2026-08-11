/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary: catches errors thrown in the ROOT layout itself (where the
 * route-level `error.tsx` cannot help because the shell failed to render). It must supply
 * its own <html>/<body>. Kept dependency-free and inline-styled so it renders even if app
 * chrome/CSS is the thing that broke.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[os] global error boundary caught:', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 32, background: '#0b0b0c', color: '#eee' }}>
        <div style={{ maxWidth: 560, margin: '10vh auto', padding: 24, border: '1px solid #333', borderRadius: 12, background: '#151517' }}>
          <h2 style={{ marginTop: 0 }}>The app hit an unexpected error</h2>
          <p style={{ color: '#aaa' }}>
            Please reload. If it keeps happening, let your administrator know.
          </p>
          {error?.message ? (
            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#888' }}>{error.message}</pre>
          ) : null}
          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <button onClick={() => reset()} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #555', background: '#e9b949', color: '#111', cursor: 'pointer' }}>
              Try again
            </button>
            <button onClick={() => window.location.reload()} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #555', background: 'transparent', color: '#eee', cursor: 'pointer' }}>
              Reload
            </button>
          </div>
          {error?.digest ? <p style={{ fontSize: 11, color: '#666', marginTop: 12 }}>Ref: {error.digest}</p> : null}
        </div>
      </body>
    </html>
  );
}
