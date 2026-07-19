/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import {
  CONTEXT_ACCESS_LABELS,
  CONTEXT_KIND_LABELS,
  accessOf,
  allowedContextAccess,
  clampContextAccess,
  isGranted,
  setGrant,
  type ContextAccess,
  type ContextAccessCap,
  type ContextGrants as ContextGrantsValue,
  type ContextKind,
} from '@/lib/core/context-grants';

/** One artifact the caller can grant — supplied by the host tab. */
export type AvailableItem = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' };

const SCOPE_LABEL: Record<AvailableItem['scope'], string> = {
  personal: 'My',
  domain: 'Domain',
  marketplace: 'Company',
};

/**
 * The OS-wide CONTEXT-GRANT picker — a reusable, tab-agnostic core primitive
 * generalised from the Agents builder's Grants surface
 * (components/agents/GrantsRouting.tsx). It lets a builder grant Connections ·
 * Data · Knowledge · Files · Metrics at Read / Read+propose / Read+write, each
 * capped by a system safety preset (`cap`).
 *
 * Purely CONTROLLED: `value` is the grants object, `onChange` receives the next
 * one, and `available` (host-supplied, already DLS-scoped) is what may be granted.
 * The host chooses which `kinds` to offer. The access `<select>` only offers the
 * levels allowed under the cap, and disables entirely when the cap is locked — the
 * SAME honest bound the Agents builder applies. Reuses the existing `.grant-block`
 * / table styling — no new visual language.
 */
export default function ContextGrants({
  value,
  onChange,
  kinds,
  available,
  cap,
  canEdit = true,
}: {
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  /** Which context kinds to offer (in order). */
  kinds: ContextKind[];
  /** The artifacts the caller may grant, per kind (host-supplied, DLS-scoped). */
  available: Partial<Record<ContextKind, AvailableItem[]>>;
  /** The system safety-preset bound; the ceiling no grant may exceed. */
  cap: ContextAccessCap;
  canEdit?: boolean;
}) {
  const options = allowedContextAccess(cap);
  return (
    <div className="context-grants">
      {kinds.map((kind) => (
        <KindGrantList
          key={kind}
          kind={kind}
          items={available[kind] ?? null}
          value={value}
          onChange={onChange}
          cap={cap}
          options={options}
          canEdit={canEdit}
        />
      ))}
      {cap.locked ? (
        <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>{cap.reason}</p>
      ) : null}
    </div>
  );
}

function KindGrantList({
  kind, items, value, onChange, cap, options, canEdit,
}: {
  kind: ContextKind;
  items: AvailableItem[] | null;
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  cap: ContextAccessCap;
  options: ContextAccess[];
  canEdit: boolean;
}) {
  const [search, setSearch] = useState('');

  // Merge granted-but-unlisted ids so an existing grant is always visible +
  // removable — never silently orphaned (mirrors the Agents Grants panel).
  const rows: AvailableItem[] = (() => {
    const listed = items ?? [];
    const known = new Set(listed.map((a) => a.id));
    const extra: AvailableItem[] = value[kind]
      .filter((g) => !known.has(g.id))
      .map((g) => ({ id: g.id, name: `(removed) ${g.id}`, scope: 'personal' as const }));
    const all = [...listed, ...extra];
    const q = search.trim().toLowerCase();
    return q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : all;
  })();

  const set = (id: string, access: ContextAccess | null) => {
    onChange(setGrant(value, kind, id, access, cap));
  };

  return (
    <div className="grant-block" style={{ marginBottom: 14 }}>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <div className="comp-label" style={{ margin: 0 }}>{CONTEXT_KIND_LABELS[kind]}</div>
        {(items?.length ?? 0) > 6 ? (
          <input
            type="text"
            placeholder={`Search ${CONTEXT_KIND_LABELS[kind].toLowerCase()}…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 200 }}
          />
        ) : null}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th><th style={{ width: 96 }}>Scope</th><th style={{ width: 96 }}>Grant</th><th style={{ width: 190 }}>Access</th>
            </tr>
          </thead>
          <tbody>
            {items === null ? (
              <tr><td colSpan={4} className="muted">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} className="muted">{search ? 'No matches.' : `No ${CONTEXT_KIND_LABELS[kind].toLowerCase()} you can access.`}</td></tr>
            ) : rows.map((a) => {
              const granted = isGranted(value, kind, a.id);
              const cur = accessOf(value, kind, a.id);
              return (
                <tr key={a.id}>
                  <td style={{ maxWidth: 0 }}>
                    <span
                      title={`${a.name} (${a.id})`}
                      style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {a.name}
                    </span>
                  </td>
                  <td><span className="badge muted">{SCOPE_LABEL[a.scope]}</span></td>
                  <td>
                    <input
                      type="checkbox"
                      checked={granted}
                      disabled={!canEdit}
                      aria-label={`Grant ${a.name}`}
                      onChange={() => set(a.id, granted ? null : clampContextAccess(cap.default, cap))}
                    />
                  </td>
                  <td>
                    {granted && canEdit && !cap.locked ? (
                      <select
                        value={cur}
                        onChange={(e) => set(a.id, e.target.value as ContextAccess)}
                        style={{ minWidth: 180 }}
                      >
                        {options.map((o) => <option key={o} value={o}>{CONTEXT_ACCESS_LABELS[o]}</option>)}
                      </select>
                    ) : granted ? (
                      <span className="badge">{CONTEXT_ACCESS_LABELS[cur]}</span>
                    ) : (
                      <span className="badge muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
