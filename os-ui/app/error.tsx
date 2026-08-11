/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary. Any unhandled throw while a page renders (e.g. a metric or
 * dashboard panel that references a since-deleted dataset) is caught HERE and shown as a
 * recoverable message INSIDE the OS shell — the Sidebar/nav stay alive, so the rest of the
 * OS keeps working and the user can switch tabs or retry. Without this, one bad component
 * white-screens the whole app ("Application error: a client-side exception has occurred").
 */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Never swallow it — surface to the console for debugging.
    console.error('[os] page error boundary caught:', error);
  }, [error]);

  return (
    <div style={{ padding: 32 }}>
      <div
        style={{
          maxWidth: 640,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          background: 'var(--panel)',
          padding: 24,
        }}
      >
        <h2 style={{ margin: '0 0 8px' }}>Something went wrong on this page</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          This section hit an error and couldn&apos;t render — often a metric or dashboard that
          points at a dataset that was deleted. The rest of the OS is unaffected; your other tabs
          still work.
        </p>
        {error?.message ? (
          <pre
            style={{
              margin: '12px 0 0',
              padding: '10px 12px',
              background: 'var(--bg, rgba(0,0,0,0.04))',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--text-faint)',
            }}
          >
            {error.message}
          </pre>
        ) : null}
        <div className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
          <button className="btn" onClick={() => reset()}>Try again</button>
          <button className="btn ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
        {error?.digest ? (
          <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>Ref: {error.digest}</p>
        ) : null}
      </div>
    </div>
  );
}
