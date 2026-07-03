/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import McpConnect from './McpConnect';

/**
 * Button + side-drawer for the per-tab MCP connect instructions.
 * Used in the top-left ActionBar on all MCP-enabled tabs.
 * The `className` prop lets callers override the button style
 * (action-bar uses "action-bar-btn"; legacy topbar used "tut-link tut-link-header").
 */
export default function McpDrawer({
  tab,
  className = 'action-bar-btn',
}: {
  tab: string;
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
              <h2>Connect your AI Tool via MCP</h2>
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
