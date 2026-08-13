/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import type { CustomBody } from '@/lib/software/appspec/schema.ts';
import { buildSandboxSrcdoc } from '@/lib/software/appspec/sandbox.ts';

/**
 * Render an author's custom HTML/CSS/JS block INSIDE A SANDBOX.
 *
 * SECURITY — the guarantee (see sandbox.ts for the full rationale):
 *   • The block runs in an `<iframe srcdoc=…>` with `sandbox="allow-scripts"` and, crucially,
 *     NO `allow-same-origin`. That makes the frame a UNIQUE, NULL origin: its JS has ZERO access
 *     to the OS session cookie, the parent DOM, or the OS's governed `/api/*` routes as the user.
 *   • Any governed data the block needs is fetched HERE, in the PARENT, AS the viewer through the
 *     `os` SDK (canView + RLS), then inlined READ-ONLY into the srcdoc as a frozen
 *     `window.__DATA__`. The iframe cannot call back into the OS, so custom JS can never act as
 *     the user or exfiltrate data — it only ever sees the snapshot the parent already resolved.
 * We deliberately do NOT set `allow-same-origin`; combining it with `allow-scripts` would let the
 * frame reach the parent origin and defeat the whole model.
 */
export function CustomBlockRenderer({ body, os }: { body: CustomBody; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; rows?: unknown; error?: string }>(
    body.data ? { status: 'loading' } : { status: 'ready' },
  );

  useEffect(() => {
    if (!body.data) {
      setState({ status: 'ready' });
      return;
    }
    let alive = true;
    setState({ status: 'loading' });
    os.datasets
      .query(body.data.datasetId, { limit: 1000 })
      .then((result: QueryResult) => {
        if (alive) setState({ status: 'ready', rows: result });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [os, body.data]);

  // The read-only data snapshot injected as window.__DATA__ (keyed by `as` when provided, so the
  // author reads e.g. window.__DATA__.orders; otherwise the QueryResult grid directly).
  const srcdoc = useMemo(() => {
    let data: unknown;
    if (body.data && state.status === 'ready') {
      data = body.data.as ? { [body.data.as]: state.rows } : state.rows;
    }
    return buildSandboxSrcdoc({ html: body.html, css: body.css, js: body.js, data });
  }, [body.html, body.css, body.js, body.data, state.status, state.rows]);

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading data for this block…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return <Alert variant="error">Could not load this block’s data: {state.error}</Alert>;
  }

  return (
    <iframe
      // NULL-origin sandbox: scripts allowed, same-origin DELIBERATELY withheld. Do not add
      // allow-same-origin — it would give the frame the OS origin and break the guarantee.
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      referrerPolicy="no-referrer"
      title="Custom block"
      style={{
        width: '100%',
        minHeight: 360,
        border: '1px solid var(--sb-border)',
        borderRadius: 'var(--sb-radius)',
        background: 'var(--sb-panel)',
      }}
    />
  );
}
