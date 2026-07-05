/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import McpConnect from './McpConnect';

/**
 * Button + side-drawer for the MCP connect instructions.
 *
 * Without a `tab` (global mode): opens the overarching /api/mcp endpoint that
 * exposes ALL golden-path tools across every tab. Used in the top-right topbar
 * so it is reachable from every page.
 *
 * With a `tab` (legacy per-tab mode, unused since Phase 7 follow-up): scoped
 * to that tab's filtered tool surface.
 *
 * The `className` prop lets callers control the button style
 * (topbar uses "topbar-mcp-btn"; action-bar used "action-bar-btn").
 */
export default function McpDrawer({
  tab,
  className = 'action-bar-btn',
}: {
  tab?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span aria-hidden className="tut-link-spark">⊕</span>
        Connect your AI Tool via MCP
      </button>

      {open && (
        <div className="drawer-backdrop" onClick={() => setOpen(false)}>
          <aside
            className="drawer"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Connect your AI Tool via MCP"
          >
            <div className="drawer-head">
              <div>
                <h2>Connect your AI Tool via MCP</h2>
                {!tab && (
                  <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)', fontWeight: 400 }}>
                    One endpoint, every golden path — build data, knowledge, agents and apps by chatting.
                  </p>
                )}
              </div>
              <button className="drawer-x" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div className="drawer-body">
              <McpConnect tab={tab} />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
