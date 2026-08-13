/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import FolderTree, { type FolderSelection, type FolderTreeItem } from '@/components/core/FolderTree';
import {
  CONTEXT_ACCESS_LABELS,
  accessOf,
  allowedContextAccess,
  clampContextAccess,
  setGrant,
  type ContextAccess,
  type ContextAccessCap,
  type ContextGrants as ContextGrantsValue,
  type ContextKind,
} from '@/lib/core/context-grants';
import {
  expandSelectionToIds,
  reconcileGranted,
  isPersonalDataGrantRisk,
  PERSONAL_DATA_GRANT_WARNING,
  type GrantableItem,
} from '@/lib/software/grant-granularity';
import {
  type AppAgentGrant,
  setAgentGrant,
} from '@/lib/software/app-agent-grants';
import {
  CHOOSE_CONTEXT_TYPES,
  CHOOSE_CONTEXT_META,
  grantedSummary,
  type ChooseContextType,
} from '@/lib/software/appspec/choose-context-model';

/** A grantable item as the /api/context/available feed returns it (folder for foldered kinds). */
type GrantItem = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace'; folder?: string };
type FolderRow = { path: string; scope: 'personal' | 'domain' };

/**
 * SoftwareContextGrants — the SIX-type Choose-Context surface (Phase 4b). It fixes the old
 * intransparency: for EACH type (Data · Metrics · Files · Knowledge · Agents · Connections)
 * a calm, collapsed row you expand into TWO unmistakable modes —
 *   • "Already available to this app" + "＋ Add existing" — pick governed artifacts you're
 *     entitled to and grant them (the folder-OR-item picker for foldered kinds, a flat list
 *     otherwise; the existing available-context feed + grant model, unchanged).
 *   • "＋ Create new" — a fresh, possibly-EMPTY artifact: Data/Files/Knowledge are created
 *     in the app's `App «Name»` folder and granted (via the context-provision route); Agents
 *     and Connections deep-link into their own tab builders; Metrics point to the Data tab
 *     (a metric is a measure on a dataset).
 *
 * Five types ride the OS-wide core ContextGrants (`value`/`onChange`); Agents ride the
 * separate `agentGrants`/`onChangeAgents` list. Governance stays server-side; this only edits
 * the capability metadata the app persists (via patchAppDesign). `onReload` re-pulls the app
 * after a create so a freshly-granted artifact shows immediately.
 */

const FOLDERED = new Set<ChooseContextType>(['data', 'knowledge', 'files']);

export default function SoftwareContextGrants({
  value,
  onChange,
  agentGrants = [],
  onChangeAgents,
  cap,
  canEdit = true,
  appId,
  appName,
  onReload,
}: {
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  agentGrants?: AppAgentGrant[];
  onChangeAgents?: (next: AppAgentGrant[]) => void;
  cap: ContextAccessCap;
  canEdit?: boolean;
  /** App id — required for the "Create new" (in-App-folder) provisioning route. */
  appId?: string;
  /** App display name — used to label the App folder a created artifact lands in. */
  appName?: string;
  /** Re-pull the app after a create-new so the new grant shows. */
  onReload?: () => void;
}) {
  return (
    <div className="context-grants">
      {CHOOSE_CONTEXT_TYPES.map((type) => (
        <TypeSection
          key={type}
          type={type}
          value={value}
          onChange={onChange}
          agentGrants={agentGrants}
          onChangeAgents={onChangeAgents}
          cap={cap}
          canEdit={canEdit}
          appId={appId}
          appName={appName}
          onReload={onReload}
        />
      ))}
      {cap.locked ? <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>{cap.reason}</p> : null}
    </div>
  );
}

/** The granted count for a type (agents ride their own list). */
function grantedCount(type: ChooseContextType, value: ContextGrantsValue, agentGrants: AppAgentGrant[]): number {
  if (type === 'agents') return agentGrants.length;
  return value[type as ContextKind]?.length ?? 0;
}

function TypeSection({
  type, value, onChange, agentGrants, onChangeAgents, cap, canEdit, appId, appName, onReload,
}: {
  type: ChooseContextType;
  value: ContextGrantsValue;
  onChange: (next: ContextGrantsValue) => void;
  agentGrants: AppAgentGrant[];
  onChangeAgents?: (next: AppAgentGrant[]) => void;
  cap: ContextAccessCap;
  canEdit: boolean;
  appId?: string;
  appName?: string;
  onReload?: () => void;
}) {
  const meta = CHOOSE_CONTEXT_META[type];
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<GrantItem[] | null>(null);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const granted = grantedCount(type, value, agentGrants);

  const load = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    const foldered = FOLDERED.has(type);
    fetch(`/api/context/available?kind=${type}${foldered ? '&folders=1' : ''}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (res.ok) {
          setItems(body.items as GrantItem[]);
          if (foldered) setFolders((body.folders as FolderRow[]) ?? []);
        } else setItems([]);
      })
      .catch(() => setItems([]));
  }, [type, loaded]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // A create-new (or a grant-on-select of a just-listed item) should refresh both the app
  // and this section's list, so the new artifact appears in "Already available" immediately.
  const refresh = useCallback(() => {
    setLoaded(false);
    setItems(null);
    onReload?.();
  }, [onReload]);

  // M8: deep-link kinds (Agents / Connections) open their builder in a NEW TAB. On return, the
  // just-built artifact won't be in this list unless we re-fetch — so re-run load when the window
  // regains focus while this section is open and points at another tab's builder.
  useEffect(() => {
    if (!open || meta.createMode !== 'deep-link') return;
    const onFocus = () => { setLoaded(false); setItems(null); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, meta.createMode]);

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
            {meta.label}
            {granted > 0 ? <span className="badge" style={{ marginLeft: 8 }}>{granted} granted</span> : null}
          </span>
          <span className="muted" style={{ fontSize: 11.5 }}>{meta.blurb}</span>
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
          {items === null ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>Loading…</p>
          ) : type === 'agents' ? (
            <AgentsPicker items={items} grants={agentGrants} onChange={onChangeAgents} canEdit={canEdit} />
          ) : FOLDERED.has(type) ? (
            <FolderedKind
              kind={type as ContextKind} items={items} folders={folders}
              value={value} onChange={onChange} cap={cap} canEdit={canEdit}
            />
          ) : (
            <FlatKind
              kind={type as ContextKind} items={items}
              value={value} onChange={onChange} cap={cap} canEdit={canEdit}
            />
          )}

          {/* ── Create new ───────────────────────────────────────────────────── */}
          {canEdit ? (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>＋ Create new</div>
              <CreateNew type={type} appId={appId} appName={appName} onCreated={refresh} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The "Create new" affordance per type — in-folder create, deep-link, or a derived pointer. */
function CreateNew({
  type, appId, appName, onCreated,
}: {
  type: ChooseContextType;
  appId?: string;
  appName?: string;
  onCreated: () => void;
}) {
  const meta = CHOOSE_CONTEXT_META[type];

  // METRICS (derived) has NO standalone create: a metric is a measure defined ON a dataset. The
  // old deep-link to /data was a dead-end (it dropped you in the whole Data tab with no next step).
  // Point the user at the honest sequence instead — grant/create a dataset here, then define its
  // metric in the Data tab — with the deep-link as a secondary aid, not the headline action.
  if (meta.createMode === 'derived') {
    return (
      <div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
          A metric is a measure on a dataset — there’s nothing to create here directly. Grant or
          create a <strong>dataset</strong> above first, then define its metric in the Data tab.
        </p>
        <Link className="btn ghost sm" href="/data" target="_blank" rel="noopener">Open the Data tab →</Link>
      </div>
    );
  }

  // Deep-link types point at another tab's own creator (Agents / Connections). On return, the
  // section re-fetches on window focus (see TypeSection) so the new artifact appears to grant.
  if (meta.createMode === 'deep-link') {
    const href = meta.createTab === 'connections' ? '/connections' : '/agents';
    return (
      <div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{meta.createNote}</p>
        <Link className="btn sm" href={href} target="_blank" rel="noopener">{meta.createLabel} →</Link>
        <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>Created it? Return to this tab — the list refreshes so you can grant it.</p>
      </div>
    );
  }

  return <CreateInFolder type={type} appId={appId} appName={appName} label={meta.createLabel} onCreated={onCreated} />;
}

/** Create a fresh, empty Data/Files/Knowledge artifact in the App folder + grant it. */
function CreateInFolder({
  type, appId, appName, label, onCreated,
}: {
  type: ChooseContextType;
  appId?: string;
  appName?: string;
  label: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // On success we keep the created artifact's name + a deep link to its tab/folder (M7).
  const [msg, setMsg] = useState<{ ok: boolean; text: string; created?: { name: string; href: string } } | null>(null);
  const folderLabel = appName ? `App «${appName}»` : 'the App folder';

  const submit = async () => {
    if (!name.trim() || !appId) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(`/api/apps/${appId}/context-provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, name: name.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Create failed');
      // Deep-link the created artifact to its own tab, filtered to the App folder it landed in.
      const tab = type === 'data' ? '/data' : type === 'files' ? '/files' : '/knowledge';
      const href = appName ? `${tab}?folder=${encodeURIComponent(`App «${appName}»`)}` : tab;
      setMsg({ ok: true, text: `Created «${body.name}» in ${folderLabel} under ${CHOOSE_CONTEXT_META[type].label}.`, created: { name: body.name, href } });
      setName('');
      onCreated();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Create failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
        Creates a fresh, empty {CHOOSE_CONTEXT_META[type].label.toLowerCase()} in <strong>{folderLabel}</strong>, granted to this app.
        {type === 'data' ? ' It starts in your personal lane — promote it to Domain in the Data tab so other users of a shared app can read it.' : ''}
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input
          type="text" value={name} disabled={busy}
          placeholder={`New ${CHOOSE_CONTEXT_META[type].label.toLowerCase()} name`}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button type="button" className="btn sm" disabled={busy || !name.trim() || !appId} onClick={submit}>
          {busy ? 'Creating…' : label}
        </button>
      </div>
      {msg ? (
        <p role="status" className="muted" style={{ fontSize: 11.5, marginTop: 6, color: msg.ok ? 'var(--ok, #16794a)' : 'var(--danger, #b42318)' }}>
          {msg.text}
          {msg.created ? (
            <>
              {' '}
              <Link href={msg.created.href} target="_blank" rel="noopener" style={{ textDecoration: 'underline' }}>
                Open «{msg.created.name}» to fill it →
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** Agents "Add existing" — a flat checkbox list of grantable agents (their own list). */
function AgentsPicker({
  items, grants, onChange, canEdit,
}: {
  items: GrantItem[];
  grants: AppAgentGrant[];
  onChange?: (next: AppAgentGrant[]) => void;
  canEdit: boolean;
}) {
  if (!onChange) return <p className="muted" style={{ fontSize: 13, margin: 0 }}>Agent grants are read-only here.</p>;
  if (items.length === 0) return <p className="muted" style={{ fontSize: 13, margin: 0 }}>No agents you can grant yet — build one in the Agents tab.</p>;
  return (
    <div>
      {items.map((a) => {
        const on = grants.some((g) => g.id === a.id);
        return (
          <label key={a.id} className="row" style={{ gap: 8, alignItems: 'center', height: 30 }}>
            <input
              type="checkbox" checked={on} disabled={!canEdit}
              aria-label={`Grant ${a.name}`}
              onChange={() => onChange(setAgentGrant(grants, a.id, on ? null : 'read-only'))}
            />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>{a.name}</span>
            {on ? <span className="badge">Runnable</span> : null}
          </label>
        );
      })}
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
  const treeItems: FolderTreeItem[] = items
    .filter((a) => a.scope === 'personal' || a.scope === 'domain')
    .map((a) => ({ id: a.id, folder: a.folder ?? '/', name: a.name, scope: a.scope as 'personal' | 'domain' }));
  const personalNodes = folders.filter((f) => f.scope === 'personal').map((f) => ({ path: f.path }));
  const domainNodes = folders.filter((f) => f.scope === 'domain').map((f) => ({ path: f.path }));
  const mktItems = items.filter((a) => a.scope === 'marketplace');

  const checkedIds = value[kind].map((g) => g.id);
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
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>No {CHOOSE_CONTEXT_META[kind as ChooseContextType].label.toLowerCase()} you can grant yet.</p>
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
    return <p className="muted" style={{ fontSize: 13, margin: 0 }}>No {CHOOSE_CONTEXT_META[kind as ChooseContextType].label.toLowerCase()} you can grant yet.</p>;
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
  const scopeOf = (id: string) => items.find((a) => a.id === id)?.scope;
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Granted access</div>
      {rows.map((g) => {
        const personalData = isPersonalDataGrantRisk(kind, scopeOf(g.id));
        return (
        <div key={g.id}>
        <div className="row" style={{ gap: 8, alignItems: 'center', height: 30 }}>
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
        {personalData ? (
          <p role="alert" className="muted" style={{ fontSize: 11.5, margin: '0 0 6px', color: 'var(--warn, #b45309)' }}>
            {PERSONAL_DATA_GRANT_WARNING}
          </p>
        ) : null}
        </div>
        );
      })}
    </div>
  );
}
