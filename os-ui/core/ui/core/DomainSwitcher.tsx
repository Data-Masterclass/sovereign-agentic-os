/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useRef, useState } from 'react';

const ALL = '__all__';

/**
 * The active operating-domain picker in the sidebar. Selecting a domain scopes
 * every tab's lists to it AND files new artifacts there; "All domains" restores
 * the cross-domain view. The choice is remembered (cookie) across logins.
 *
 * On switch we do a FULL page reload — the active domain re-scopes server reads
 * AND every tab's own client-side fetch, so a hard reload is the only reliable
 * way to re-request everything against the new scope (router.refresh() alone
 * leaves client-fetched lists stale).
 */
export function DomainSwitcher({
  allDomains,
  activeDomain,
}: {
  allDomains: string[];
  activeDomain: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = activeDomain ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function pick(domain: string | null) {
    setOpen(false);
    if (domain === current) return; // no-op — already operating here
    setBusy(true);
    try {
      await fetch('/api/session/active-domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain }),
      });
      window.location.reload(); // hard re-scope: server + every tab's fetch
    } catch {
      setBusy(false); // leave the UI usable if the switch failed
    }
  }

  const options: { id: string; label: string }[] = [
    { id: ALL, label: 'All domains' },
    ...allDomains.map((d) => ({ id: d, label: d })),
  ];

  return (
    <div className="domain-switch" ref={ref}>
      <span className="domain-switch-label">Domain:</span>
      <button
        type="button"
        className="domain-switch-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose the domain you operate in"
      >
        <span className={`domain-switch-dot${current ? '' : ' all'}`} />
        <span className="domain-switch-current">{busy ? 'Switching…' : (current ?? 'All domains')}</span>
        <span className="domain-switch-caret" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <ul className="domain-switch-menu" role="listbox">
          {options.map((o) => {
            const target = o.id === ALL ? null : o.id;
            const on = target === current;
            return (
              <li key={o.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`domain-switch-opt${on ? ' on' : ''}`}
                  onClick={() => pick(target)}
                >
                  <span className="domain-switch-check" aria-hidden>{on ? '✓' : ''}</span>
                  <span className="domain-switch-opt-label">{o.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
