/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { grantedSummary } from '@core/kernel/choose-context';

/**
 * ChooseContextShell — the SHARED, tab-agnostic "Choose Context" chrome, lifted out
 * of the Software tab (`SoftwareContextGrants` → `TypeSection`) so every builder tab
 * (Software today, Agents next) renders the same calm surface: for EACH grantable
 * type, a collapsed row you expand into TWO unmistakable modes —
 *   • "grantedSummary · ＋ Add existing" — pick governed artifacts you're entitled to
 *     and grant them (the HOST supplies this body via `renderPicker`).
 *   • "＋ Create new" — a fresh artifact (the HOST supplies this body via
 *     `renderCreateNew`; the shell only draws the divider + heading + gate).
 *
 * This component is PRESENTATION-ONLY: it owns the collapse row, the expand
 * animation, the lazy per-type feed fetch, and the deep-link focus-refresh. It holds
 * NO grant-value logic and NO folder→id expansion — those stay in the host's picker
 * body, so a tab that needs late-binding folder grants (Agents) can supply its own.
 */

/** A tab-agnostic descriptor of one Choose-Context type the shell renders. */
export type ContextTypeDescriptor = {
  /** Stable key for this type (React key + fetch identity). */
  key: string;
  label: string;
  blurb: string;
  /** How many artifacts of this type are currently granted (drives the badge + summary). */
  grantedCount: number;
  /** Lazy-load this type's grantable feed once, when the section first opens. */
  loadAvailable: () => Promise<{ items: unknown; folders?: unknown }>;
  /** Host-supplied grant body for "＋ Add existing", given the loaded feed. */
  renderPicker: (feed: { items: unknown; folders?: unknown }) => ReactNode;
  /**
   * "＋ Create new" specifics. `mode` decides whether this type re-fetches on window
   * focus (deep-link types build their artifact in another tab). `render` supplies the
   * host's create body; when omitted the shell draws no "Create new" block (e.g. the
   * host chose not to offer it, or the viewer can't edit).
   *
   * `onRefresh` lets the host force a re-fetch of the feed (after an in-folder create).
   */
  createNew?: {
    mode: 'in-folder' | 'deep-link' | 'derived';
    render?: (helpers: { refresh: () => void }) => ReactNode;
  };
};

export default function ChooseContextShell({ types, footer }: {
  types: ContextTypeDescriptor[];
  /** Optional trailing note under the list (e.g. a locked-cap reason). */
  footer?: ReactNode;
}) {
  return (
    <div className="context-grants">
      {types.map((d) => (
        <TypeSection key={d.key} descriptor={d} />
      ))}
      {footer}
    </div>
  );
}

function TypeSection({ descriptor }: { descriptor: ContextTypeDescriptor }) {
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<{ items: unknown; folders?: unknown } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const granted = descriptor.grantedCount;

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    descriptor.loadAvailable()
      .then((body) => setFeed(body))
      .catch(() => setFeed({ items: [] }));
  }, [loaded, descriptor]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // A create-new (or a grant-on-select of a just-listed item) should re-fetch this
  // section's list, so a newly-granted artifact appears in "Already available".
  const refresh = useCallback(() => {
    setLoaded(false);
    setFeed(null);
  }, []);

  // M8: deep-link kinds (Agents / Connections) open their builder in a NEW TAB. On
  // return, the just-built artifact won't be in this list unless we re-fetch — so
  // re-run load when the window regains focus while this section is open.
  const createMode = descriptor.createNew?.mode;
  useEffect(() => {
    if (!open || createMode !== 'deep-link') return;
    const onFocus = () => { setLoaded(false); setFeed(null); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, createMode]);

  return (
    <div className="grant-block" style={{ marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
      <button
        type="button"
        className="row"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
        }}
        aria-expanded={open}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="comp-label" style={{ margin: 0 }}>
            {descriptor.label}
            {granted > 0 ? <span className="badge" style={{ marginLeft: 8 }}>{granted} granted</span> : null}
          </span>
          <span className="muted" style={{ fontSize: 11.5 }}>{descriptor.blurb}</span>
        </span>
        <span aria-hidden style={{ color: 'var(--text-faint)', fontSize: 11, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>▶</span>
      </button>

      {open ? (
        <div style={{ marginTop: 12 }}>
          {/* ── Already available + Add existing ─────────────────────────────── */}
          <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            {grantedSummary(granted)}
            <span style={{ fontWeight: 400 }}> · ＋ Add existing</span>
          </div>
          {feed === null ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>Loading…</p>
          ) : (
            descriptor.renderPicker(feed)
          )}

          {/* ── Create new ───────────────────────────────────────────────────── */}
          {descriptor.createNew?.render ? (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>＋ Create new</div>
              {descriptor.createNew.render({ refresh })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
