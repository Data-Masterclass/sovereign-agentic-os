/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * Embedded tool surface. The OS shell hosts the underlying tool's own GUI inline
 * (Superset, OpenMetadata, Cube Playground, Langfuse, a Supabase studio, …) so the
 * domain user stays in one app for the common case, and only drops to the native
 * console for deep/advanced work. Some tools send X-Frame-Options/CSP that block
 * framing; we always offer an "open in new tab" fallback and let the user toggle
 * the embed on demand (so a blocked iframe never breaks the page).
 */
export default function ToolEmbed({
  url,
  title,
  height = 620,
  note,
}: {
  url: string;
  title: string;
  height?: number;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <div>
          <div style={{ fontWeight: 600 }}>{title}</div>
          <div className="muted mono" style={{ fontSize: 11 }}>{url}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn ghost" style={{ padding: '5px 12px' }} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide embed' : 'Embed here'}
          </button>
          <a className="btn" style={{ padding: '5px 12px' }} href={url} target="_blank" rel="noreferrer">Open ↗</a>
        </div>
      </div>
      {open ? (
        <>
          <iframe src={url} title={title} style={{ width: '100%', height, border: 0, display: 'block' }} sandbox="allow-same-origin allow-scripts allow-forms allow-popups" />
          {note ? <div className="hint" style={{ padding: '8px 14px', marginTop: 0 }}>{note}</div> : null}
        </>
      ) : (
        <div className="hint" style={{ padding: '12px 14px', marginTop: 0 }}>
          Embed the {title} GUI inline, or open it in a new tab. {note ?? ''} If the frame stays blank, the tool blocks embedding — use “Open ↗”.
        </div>
      )}
    </div>
  );
}
