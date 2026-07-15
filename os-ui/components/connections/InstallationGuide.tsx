/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <InstallationGuide /> — a clean side panel that shows one connector's install
 * guide (Prerequisites → Steps → What the OS does) from lib/connections/install-guides.
 *
 * Opened by the "Installation Guide" button on every Supported Connector card. The
 * body is portable markdown rendered through the shared <Markdown> component so it
 * blends with the rest of the OS UI. Dismiss via the backdrop, the ✕, or Escape.
 */

import { useEffect } from 'react';
import Markdown from '@/components/Markdown';
import { guideMarkdown, type InstallGuide } from '@/lib/connections/install-guides';

export default function InstallationGuide({ guide, onClose }: { guide: InstallGuide; onClose: () => void }) {
  // Escape closes the panel — the same affordance every OS overlay offers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Installation guide — ${guide.title}`}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', justifyContent: 'flex-end',
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 100%)', height: '100%',
          margin: 0, borderRadius: 0,
          overflowY: 'auto',
          borderLeft: '1px solid var(--gold-line)',
        }}
      >
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div className="mono" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-faint)' }}>
              Installation guide
            </div>
            <h3 style={{ margin: '4px 0 0' }}>{guide.title}</h3>
          </div>
          <button className="btn ghost" onClick={onClose} aria-label="Close installation guide">✕</button>
        </div>
        <div style={{ marginTop: 14 }}>
          <Markdown>{guideMarkdown(guide)}</Markdown>
        </div>
      </div>
    </div>
  );
}
