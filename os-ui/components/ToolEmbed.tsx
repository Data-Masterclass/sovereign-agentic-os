/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useToolWindow } from '@/components/ToolWindowProvider';

/**
 * Embedded tool surface. The OS shell hosts the underlying tool's own GUI inline
 * (Superset, OpenMetadata, Cube Playground, …) so the domain user stays in one
 * app. When `toolKey` is set the primary action opens the tool SAME-ORIGIN in
 * the full-bleed overlay (proxied by the os-ui server via /tools/<key>, using
 * only the OS session — no localhost, no cross-tool login). `url` stays as a
 * secondary "open native" link for deep/advanced work. Without `toolKey` this
 * falls back to the legacy inline-iframe toggle against `url`.
 */
export default function ToolEmbed({
  url,
  title,
  height = 620,
  note,
  toolKey,
}: {
  url: string;
  title: string;
  height?: number;
  note?: string;
  /** Registry key (lib/tool-proxy.ts). When set, opens same-origin via the overlay. */
  toolKey?: string;
}) {
  const { openTool } = useToolWindow();
  const [open, setOpen] = useState(false);

  if (toolKey) {
    return (
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{title}</div>
            <div className="muted mono" style={{ fontSize: 11 }}>/tools/{toolKey}</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" style={{ padding: '5px 12px' }} onClick={() => openTool(toolKey, title)}>
              Open {title}
            </button>
            {url ? (
              <a className="btn ghost" style={{ padding: '5px 12px' }} href={url} target="_blank" rel="noreferrer">Native ↗</a>
            ) : null}
          </div>
        </div>
        <div className="hint" style={{ padding: '12px 14px', marginTop: 0 }}>
          Opens {title} in-app, same-origin, with your OS session. {note ?? ''}
        </div>
      </div>
    );
  }

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
