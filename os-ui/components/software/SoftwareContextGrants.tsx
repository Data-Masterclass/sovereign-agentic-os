/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import FolderTree, { type FolderSelection, type FolderTreeItem } from '@/components/core/FolderTree';
import {
  CONTEXT_KIND_LABELS,
  CONTEXT_ACCESS_LABELS,
  accessOf,
  allowedContextAccess,
  clampContextAccess,
  grantCountForKind,
  setGrant,
  type ContextAccess,
  type ContextAccessCap,
  type ContextGrants as ContextGrantsValue,
  type ContextKind,
} from '@/lib/core/context-grants';
import { expandSelectionToIds, reconcileGranted, type GrantableItem } from '@/lib/software/grant-granularity';

/** A grantable item as the /api/context/available feed returns it (folder for foldered kinds). */
type GrantItem = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace'; folder?: string };

/**
 * SoftwareContextGrants — the Define-stage grant surface. Each kind is a calm,
 * collapsed row you EXPAND on click (Apple-simple: nothing overwhelms until asked).
 * When expanded:
 *   • FOLDERED kinds (Data · Knowledge · Files) show the shared <FolderTree> so you
 *     grant at FOLDER level (tick a folder → every item under it) OR at ITEM level
 *     (tick one item). A folder tick expands to its member item ids, so the persisted
 *     grants stay the plain, backward-compatible item-id ContextGrants shape.
 *   • FLAT kinds (Connections · Metrics) show a simple checkbox list.
 * A per-item access selector (Read / Read+propose / Read+write) sits below, bounded by
 * the safety `cap` exactly like the core picker.
 *
 * Controlled: `value` is the grants object, `onChange` the next one. `available` and
 * `folders` are host-supplied + DLS-scoped. Governance stays server-side; this only
 * edits the capability metadata the app persists via patchAppDesign.
 */

type FolderRow = { path: string; scope: 'personal' | 'domain' };

const FOLDERED = new Set<ContextKind>(['data', 'knowledge', 'files']);

export default function SoftwareContextGrants({
  value,
  onChange,
  kinds,
  cap,
  canEdit = true,
}: {
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  kinds: ContextKind[];
  cap: ContextAccessCap;
  canEdit?: boolean;
}) {
  return (
    <div className="context-grants">
      {kinds.map((kind) => (
        <KindRow key={kind} kind={kind} value={value} onChange={onChange} cap={cap} canEdit={canEdit} />
      ))}
      {cap.locked ? <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>{cap.reason}</p> : null}
    </div>
  );
}

function KindRow({
  kind, value, onChange, cap, canEdit,
}: {
  kind: ContextKind;
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  cap: ContextAccessCap;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<GrantItem[] | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const granted = grantCountForKind(value, kind);

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    const foldered = FOLDERED.has(kind);
    fetch(`/api/context/available?kind=${kind}${foldered ? '&folders=1' : ''}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (res.ok) {
          setItems(body.items as GrantItem[]);
          if (foldered) setFolders((body.folders as FolderRow[]) ?? []);
        } else {
          setItems([]);
        }
      })
      .catch(() => setItems([]));
  }, [kind, loaded]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  return (
    <div className="grant-block" style={{ marginBottom: 12 }}>
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
        <span className="comp-label" style={{ margin: 0 }}>
          {CONTEXT_KIND_LABELS[kind]}
          {granted > 0 ? <span className="badge" style={{ marginLeft: 8 }}>{granted} granted</span> : null}
        </span>
        <span aria-hidden style={{ color: 'var(--text-faint)', fontSize: 11, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}>▶</span>
      </button>

      {open ? (
        <div style={{ marginTop: 10 }}>
          {items === null ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>Loading…</p>
          ) : FOLDERED.has(kind) ? (
            <FolderedKind
              kind={kind} items={items} folders={folders}
              value={value} onChange={onChange} cap={cap} canEdit={canEdit}
            />
          ) : (
            <FlatKind
              kind={kind} items={items}
              value={value} onChange={onChange} cap={cap} canEdit={canEdit}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Foldered kind — FolderTree (folder OR item ticks) + a per-granted-item access list. */
function FolderedKind({
  kind, items, folders, value, onChange, cap, canEdit,
}: {
  kind: ContextKind;
  items: GrantItem[];
  folders: FolderRow[];
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  cap: ContextAccessCap;
  canEdit: boolean;
}) {
  // FolderTree wants items carrying { id, folder, name, scope }. Marketplace items have
  // no folder tree → they render at their own root ('/'), still item-grantable.
  const treeItems: FolderTreeItem[] = items
    .filter((a) => a.scope === 'personal' || a.scope === 'domain')
    .map((a) => ({ id: a.id, folder: a.folder ?? '/', name: a.name, scope: a.scope as 'personal' | 'domain' }));
  const personalNodes = folders.filter((f) => f.scope === 'personal').map((f) => ({ path: f.path }));
  const domainNodes = folders.filter((f) => f.scope === 'domain').map((f) => ({ path: f.path }));
  const mktItems = items.filter((a) => a.scope === 'marketplace');

  const checkedIds = value[kind].map((g) => g.id);

  // A FolderTree change gives folderGrants + itemGrants; expand each folder grant to the
  // member item ids it covers, union with explicit item grants → the flat granted set.
  const grantable: GrantableItem[] = treeItems.map((it) => ({ id: it.id, folder: it.folder, scope: it.scope as 'personal' | 'domain' }));
  const onTree = (sel: FolderSelection) => {
    if (!canEdit) return;
    const next = expandSelectionToIds(grantable, sel.folderGrants, sel.itemGrants);
    onChange(reconcileGranted(value, kind, next, cap));
  };

  const options = allowedContextAccess(cap);
  const grantedRows = value[kind];

  return (
    <div>
      {treeItems.length === 0 && folders.length === 0 && mktItems.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>No {CONTEXT_KIND_LABELS[kind].toLowerCase()} you can grant yet.</p>
      ) : (
        <>
          {treeItems.length > 0 || folders.length > 0 ? (
            <FolderTree
              variant="checkbox"
              personalNodes={personalNodes}
              domainNodes={domainNodes}
              items={treeItems}
              checkedIds={checkedIds}
              onChange={onTree}
            />
          ) : null}

          {/* Marketplace items sit outside the folder tree — a small flat picker keeps
              them grantable at item level. */}
          {mktItems.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Company (no folders)</div>
              {mktItems.map((a) => {
                const on = value[kind].some((g) => g.id === a.id);
                return (
                  <label key={a.id} className="row" style={{ gap: 8, alignItems: 'center', height: 28 }}>
                    <input
                      type="checkbox" checked={on} disabled={!canEdit}
                      onChange={() => onChange(setGrant(value, kind, a.id, on ? null : clampContextAccess(cap.default, cap), cap))}
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</span>
                  </label>
                );
              })}
            </div>
          ) : null}
        </>
      )}

      {/* Access controls for each granted item (the tree ticks membership; access lives here). */}
      {grantedRows.length > 0 ? (
        <GrantedAccessList
          kind={kind} rows={grantedRows} items={items}
          value={value} onChange={onChange} cap={cap} options={options} canEdit={canEdit}
        />
      ) : null}
    </div>
  );
}

/** Flat kind (Connections · Metrics) — a simple checkbox list + inline access. */
function FlatKind({
  kind, items, value, onChange, cap, canEdit,
}: {
  kind: ContextKind;
  items: GrantItem[];
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  cap: ContextAccessCap;
  canEdit: boolean;
}) {
  const options = allowedContextAccess(cap);
  if (items.length === 0) {
    return <p className="muted" style={{ fontSize: 13, margin: 0 }}>No {CONTEXT_KIND_LABELS[kind].toLowerCase()} you can grant yet.</p>;
  }
  return (
    <div>
      {items.map((a) => {
        const on = value[kind].some((g) => g.id === a.id);
        const cur = accessOf(value, kind, a.id);
        return (
          <div key={a.id} className="row" style={{ gap: 8, alignItems: 'center', height: 32 }}>
            <input
              type="checkbox" checked={on} disabled={!canEdit}
              aria-label={`Grant ${a.name}`}
              onChange={() => onChange(setGrant(value, kind, a.id, on ? null : clampContextAccess(cap.default, cap), cap))}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</span>
            {on && canEdit && !cap.locked ? (
              <select value={cur} onChange={(e) => onChange(setGrant(value, kind, a.id, e.target.value as ContextAccess, cap))} style={{ minWidth: 160 }}>
                {options.map((o) => <option key={o} value={o}>{CONTEXT_ACCESS_LABELS[o]}</option>)}
              </select>
            ) : on ? (
              <span className="badge">{CONTEXT_ACCESS_LABELS[cur]}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The access-level list for the currently-granted items of a foldered kind. */
function GrantedAccessList({
  kind, rows, items, value, onChange, cap, options, canEdit,
}: {
  kind: ContextKind;
  rows: { id: string; access: ContextAccess }[];
  items: GrantItem[];
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  cap: ContextAccessCap;
  options: ContextAccess[];
  canEdit: boolean;
}) {
  const nameOf = (id: string) => items.find((a) => a.id === id)?.name ?? id;
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Granted access</div>
      {rows.map((g) => (
        <div key={g.id} className="row" style={{ gap: 8, alignItems: 'center', height: 30 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={nameOf(g.id)}>{nameOf(g.id)}</span>
          {canEdit && !cap.locked ? (
            <select value={g.access} onChange={(e) => onChange(setGrant(value, kind, g.id, e.target.value as ContextAccess, cap))} style={{ minWidth: 160 }}>
              {options.map((o) => <option key={o} value={o}>{CONTEXT_ACCESS_LABELS[o]}</option>)}
            </select>
          ) : (
            <span className="badge">{CONTEXT_ACCESS_LABELS[g.access]}</span>
          )}
          {canEdit ? (
            <button type="button" className="icon-btn danger" title="Remove grant" onClick={() => onChange(setGrant(value, kind, g.id, null, cap))}>✕</button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

