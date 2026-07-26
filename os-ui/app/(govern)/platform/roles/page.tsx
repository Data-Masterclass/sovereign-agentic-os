/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type Role = 'creator' | 'builder' | 'domain_admin' | 'admin';
type Capability = 'view' | 'create' | 'run' | 'request' | 'approve' | 'manage';
type Comp = { id: string; label: string; hint: string };
type Cap = { id: Capability; label: string; glyph: string; hint: string };
type RoleInfo = { id: Role; label: string; blurb: string; rights: string[]; tools: string[] };
type Matrix = Record<Role, Record<string, Capability[]>>;
type View = {
  components: Comp[];
  capabilities: Cap[];
  applicable: Record<string, Capability[]>;
  matrix: Matrix;
  roles: RoleInfo[];
};

const ROLE_ORDER: Role[] = ['creator', 'builder', 'domain_admin', 'admin'];

function has(matrix: Matrix, role: Role, comp: string, cap: Capability): boolean {
  return (matrix[role]?.[comp] ?? []).includes(cap);
}

type Diff = { role: Role; comp: string; compLabel: string; cap: Capability; capLabel: string; enabled: boolean };

export default function RolesPage() {
  const [view, setView] = useState<View | null>(null);
  const [local, setLocal] = useState<Matrix | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/roles', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else {
        setView(body);
        setLocal(JSON.parse(JSON.stringify(body.matrix)));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = useCallback((role: Role, comp: string, cap: Capability) => {
    setNote('');
    setLocal((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as Matrix;
      const set = new Set(next[role][comp] ?? []);
      if (set.has(cap)) set.delete(cap); else set.add(cap);
      next[role][comp] = [...set];
      return next;
    });
  }, []);

  const diffs = useMemo<Diff[]>(() => {
    if (!view || !local) return [];
    const out: Diff[] = [];
    for (const role of ROLE_ORDER) {
      for (const c of view.components) {
        for (const cap of view.applicable[c.id] ?? []) {
          const before = has(view.matrix, role, c.id, cap);
          const after = has(local, role, c.id, cap);
          if (before !== after) {
            const capLabel = view.capabilities.find((k) => k.id === cap)?.label ?? cap;
            out.push({ role, comp: c.id, compLabel: c.label, cap, capLabel, enabled: after });
          }
        }
      }
    }
    return out;
  }, [view, local]);

  const save = useCallback(async () => {
    if (!diffs.length) return;
    setBusy(true); setError('');
    try {
      let latest: View | null = null;
      for (const d of diffs) {
        const res = await fetch('/api/platform-admin/roles', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: d.role, component: d.comp, capability: d.cap, enabled: d.enabled }),
        });
        const body = await res.json();
        if (!res.ok) { setError(body.error ?? 'Save failed'); await load(); return; }
        latest = body;
      }
      if (latest) {
        setView(latest);
        setLocal(JSON.parse(JSON.stringify(latest.matrix)));
        setNote(`Saved ${diffs.length} change${diffs.length > 1 ? 's' : ''} · recompiled OPA grants`);
      }
    } finally {
      setBusy(false);
    }
  }, [diffs, load]);

  const discard = useCallback(() => {
    if (view) setLocal(JSON.parse(JSON.stringify(view.matrix)));
    setNote('');
  }, [view]);

  if (!view || !local) {
    return (
      <>
        <PageHeader title="Roles & Permissions" crumb="platform · role types & what they may do" />
        <div className="content">{error ? <div className="error">{error}</div> : <div className="stub-page">Loading roles…</div>}</div>
      </>
    );
  }

  const chip = (role: Role, comp: string, cap: Cap): React.CSSProperties => {
    const on = has(local, role, comp, cap.id);
    const changed = has(view.matrix, role, comp, cap.id) !== on;
    return {
      display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', minWidth: 74,
      justifyContent: 'center', borderRadius: 999, fontSize: 11, cursor: 'pointer', userSelect: 'none',
      border: `1px solid ${changed ? 'var(--teal)' : on ? 'var(--gold-line)' : 'var(--border)'}`,
      background: on ? 'var(--gold-soft)' : 'transparent',
      color: on ? 'var(--gold-text)' : 'var(--text-faint)',
      fontWeight: on ? 600 : 400,
      boxShadow: changed ? '0 0 0 2px color-mix(in srgb, var(--teal) 22%, transparent)' : 'none',
      transition: 'all .12s ease',
    };
  };

  return (
    <>
      <PageHeader title="Roles & Permissions" crumb="platform · role types & what they may do" />
      <div className="content">
        <p className="lead">
          Set up the <strong>role types</strong> and, for every component and golden path, exactly what each
          category may do. Seeded from how the OS runs today (<strong>creator · builder · domain admin · admin</strong>)
          so nothing changes until you adjust it — every edit recompiles to the same OPA policy the whole platform
          enforces, and is audited.
        </p>

        {/* Role summary cards — one-line description + live compiled rights/tools. */}
        <div className="pa-kpis" style={{ marginBottom: 8 }}>
          {view.roles.map((r) => (
            <div className="card pa-kpi" key={r.id} style={{ alignItems: 'flex-start' }}>
              <span className="k-label">{r.label}</span>
              <span className="k-sub" style={{ marginTop: 2 }}>{r.blurb}</span>
              <span className="k-sub" style={{ marginTop: 8 }}>
                {r.rights.length} rights · {r.tools.length} OPA tool{r.tools.length === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>

        {/* Capability legend. */}
        <div className="hint" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '6px 0 14px' }}>
          {view.capabilities.map((c) => (
            <span key={c.id} title={c.hint}><strong style={{ color: 'var(--gold-text)' }}>{c.label}</strong> — {c.hint}</span>
          ))}
        </div>

        {error ? <div className="error">{error}</div> : null}
        {note ? <div className="hint" style={{ color: 'var(--teal)', marginBottom: 10 }}>✓ {note}</div> : null}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 150 }}>Component / golden path</th>
                {ROLE_ORDER.map((r) => <th key={r} style={{ textTransform: 'capitalize' }}>{r}</th>)}
              </tr>
            </thead>
            <tbody>
              {view.components.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.label}</strong>
                    <div className="muted" style={{ fontSize: 11 }}>{c.hint}</div>
                  </td>
                  {ROLE_ORDER.map((role) => (
                    <td key={role} style={{ verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, maxWidth: 250 }}>
                        {view.capabilities.map((cap) => {
                          const applicable = (view.applicable[c.id] ?? []).includes(cap.id);
                          if (!applicable) {
                            return (
                              <span key={cap.id} title={`${cap.label} — not applicable here`} style={{ minWidth: 74, textAlign: 'center', color: 'var(--text-faint)', opacity: 0.4, fontSize: 11, padding: '3px 8px' }}>—</span>
                            );
                          }
                          return (
                            <button
                              key={cap.id}
                              type="button"
                              title={`${cap.label} — ${cap.hint}`}
                              onClick={() => toggle(role, c.id, cap.id)}
                              style={chip(role, c.id, cap)}
                            >
                              <span aria-hidden>{cap.glyph}</span>{cap.label}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sticky "what changes" bar — only when there are pending edits. */}
      {diffs.length > 0 ? (
        <div style={{
          position: 'sticky', bottom: 0, marginTop: 16, padding: '14px 18px',
          background: 'var(--panel)', borderTop: '1px solid var(--border-strong)',
          display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        }}>
          <div style={{ flex: '1 1 320px' }}>
            <strong style={{ fontSize: 13 }}>{diffs.length} pending change{diffs.length > 1 ? 's' : ''}</strong>
            <div className="muted" style={{ fontSize: 12, marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {diffs.slice(0, 6).map((d, i) => (
                <span key={i}>
                  <span style={{ textTransform: 'capitalize' }}>{d.role}</span> · {d.compLabel} · {d.capLabel}:{' '}
                  <span style={{ color: d.enabled ? 'var(--teal)' : 'var(--danger)' }}>{d.enabled ? 'granted' : 'revoked'}</span>
                </span>
              ))}
              {diffs.length > 6 ? <span>+{diffs.length - 6} more</span> : null}
            </div>
          </div>
          <button className="btn ghost" onClick={discard} disabled={busy}>Discard</button>
          <button className="btn" onClick={save} disabled={busy}>{busy ? <span className="spin" /> : 'Save & recompile'}</button>
        </div>
      ) : null}
    </>
  );
}
