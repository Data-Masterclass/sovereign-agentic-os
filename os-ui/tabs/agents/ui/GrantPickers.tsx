/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import type { System, DataLayer, SafetyPreset } from '@tabs/agents/lib/system-schema';
import {
  setDataGrantLayer, removeArtifactGrant, removeFolderGrant,
  setArtifactGrantLevel, setFolderGrantLevel, setFolderGrant,
} from '@tabs/agents/lib/simple-edit';
import {
  applyFolderSelection, folderGrantsOf, checkedIdsFor, rootGrantedScopes, emptyFolderGrants,
  treeProtectedFolders, folderGrantCoverage, zeroMatchWarning, isOutputFolder,
} from '@tabs/agents/lib/grant-apply';
import {
  accessCap, allowedAccessLevels, capabilityToAccess, clampAccess,
  ACCESS_LABELS, type AccessLevel, type AccessCap,
} from '@tabs/agents/lib/access-levels';
import { scopeLabel, type ScopeKey } from '@core/kernel/scopes';
import FolderTree, { type FolderSelection } from '@core/ui/core/FolderTree';
import { normaliseFolderPath } from '@core/kernel/folders';
import { grantWarningKey, type GrantWarning } from '@tabs/agents/lib/grant-access';

/**
 * The AGENTS grant-picker bodies — extracted VERBATIM out of SimpleBuilder (no behaviour
 * change) so the new Grant stage can mount them inside the shared `<ChooseContextShell>`
 * while the builder orchestrator stays lean. Each of these preserves the agents' unique
 * grant semantics that the shell deliberately does NOT own:
 *
 *   • late-binding FOLDER grants (a folder grant that reaches every item under it, incl.
 *     future ones) via `FolderResourcePicker` + `applyFolderSelection`;
 *   • per-item ACCESS CAPS bounded by the system safety preset (`AccessLevelSelect` +
 *     `AccessCapNote`);
 *   • the DATA medallion Bronze/Silver/Gold toggle (`LayerToggle`);
 *   • the "pick an existing folder OR ＋ New folder" affordance (`NewFolderField`).
 *
 * All edits flow through `onCommit(nextSystem)` → the existing governed system.yaml write,
 * exactly as before — nothing new is persisted here.
 */

export type Available = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace'; layers?: DataLayer[]; folder?: string };
/** A folder row from the feed. `outsideDomain` marks a row that is only present because a
 *  LIVE grant on this system points at it from outside the system's domain — the feed is
 *  otherwise narrowed to that domain. Such a row is deliberately NOT put into the tree: the
 *  narrowed feed gives it no items, and an item-less folder renders UNTICKED (`triState`
 *  returns 'none'), which would show a live grant as un-granted. It is rendered instead as a
 *  read-only chip with a warning, and passed to the reconcile as PROTECTED so that no
 *  tick-and-save round trip can delete it. */
export type FolderNode = { path: string; scope: 'personal' | 'domain'; outsideDomain?: boolean };
export type AvailableFeed = { items: Available[]; folders?: FolderNode[]; grantWarnings?: GrantWarning[] };

/** The short badge for a grant the CALLER cannot use (`tabs/agents/lib/grant-access.ts`). */
const WARNING_BADGE: Record<GrantWarning['status'], string> = {
  'not-visible': "you can't see this",
  'not-found': 'not found',
  'outside-domain': 'outside this domain',
};

/** `kind:id` → warning, for looking a warning up next to its grant chip. */
function warningIndex(ws: GrantWarning[] | undefined): Map<string, GrantWarning> {
  return new Map((ws ?? []).map((w) => [grantWarningKey(w), w]));
}

/**
 * The badge + sentence shown next to a grant the caller cannot use. The sentence comes from the
 * server and names nothing but the grant's own id and the team's domain — never a hidden
 * resource's name or owner. A warning: the grant stays, and the run-time check is the gate.
 */
export function GrantWarningNote({ warning }: { warning: GrantWarning }) {
  return (
    <>
      <span className="badge warn" style={{ marginLeft: 6 }} title={warning.message}>{WARNING_BADGE[warning.status]}</span>
      <span className="hint" role="note" style={{ display: 'block', marginTop: 2, color: 'var(--warn, #b7791f)', whiteSpace: 'normal' }}>
        {warning.message}
      </span>
    </>
  );
}

/** Highest built layer of a dataset (Gold > Silver > Bronze), or null if none built. */
export function highestLayer(layers: DataLayer[] | undefined): DataLayer | null {
  if (!layers || layers.length === 0) return null;
  if (layers.includes('gold')) return 'gold';
  if (layers.includes('silver')) return 'silver';
  if (layers.includes('bronze')) return 'bronze';
  return null;
}

/**
 * Wave-3 folder-aware grant picker for the FOLDERED kinds (data · knowledge · files).
 * Renders the shared `<FolderTree variant="checkbox">` over the DLS-scoped feed so the
 * author ticks whole FOLDERS (→ a folder grant that late-binds to every item under it,
 * incl. future ones) or individual ITEMS. The feed is already DLS-scoped, so only
 * grantable items show — a folder that also holds ungrantable items simply renders as
 * a partial (tri-state) tick, honest by construction. Granted resources are listed
 * below with their access toggle (Read / Can-write) + medallion layer (data), reusing
 * the same controls the flat picker used. Marketplace items (no folder tree) keep a
 * small supplementary add-picker so nothing that was grantable before is lost.
 */
export function FolderResourcePicker({
  systemId, system, kind, label, canEdit, onCommit, hideLabel,
}: {
  systemId: string;
  system: System;
  kind: 'data' | 'knowledge' | 'workflows' | 'files';
  label: string;
  canEdit: boolean;
  onCommit: (next: System) => void;
  /** Suppress the internal category label — the caller renders a prominent one. */
  hideLabel?: boolean;
}) {
  const [feed, setFeed] = useState<AvailableFeed | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [mktOpen, setMktOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadErr('');
    fetch(`/api/agents/systems/${systemId}/grants/available?kind=${kind}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load');
        if (alive) setFeed(body as AvailableFeed);
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, [systemId, kind]);

  // Workflows (own Plan-Items member) and Knowledge (Context) each have their OWN feed.
  const inFamily = (_id: string) => true;
  const items = feed?.items ?? [];
  const allFolders = feed?.folders ?? [];
  // A folder flagged `outsideDomain` exists only because a LIVE grant points at it from
  // outside this system's domain. It is deliberately NOT a tree node: the narrowed feed gives
  // it no items, and `triState` renders an item-less folder UNTICKED — a tree that showed a
  // live grant as unticked would be a lie, and the next tick would emit a selection without
  // it and delete it. It is rendered below as a read-only chip with a warning instead, and
  // passed to the reconcile as protected so no round trip can remove it.
  const outsideFolders = allFolders.filter((f) => f.outsideDomain);
  const folders = allFolders.filter((f) => !f.outsideDomain);
  const availOf = (id: string) => items.find((a) => a.id === id);
  const nameOf = (id: string) => availOf(id)?.name ?? (id.includes('_') ? id.split('_').slice(1).join('_') : id);
  const layersOf = (id: string): DataLayer[] => availOf(id)?.layers ?? [];
  const layerFor = (id: string): DataLayer => (kind === 'data' ? (highestLayer(layersOf(id)) ?? 'gold') : 'gold');

  // Split the feed: foldered (personal/domain) items feed the tree; marketplace items
  // (no folder tree) keep a flat supplementary picker. Each tree item carries its
  // scope so the FolderTree shows it under ONLY its own root (My vs Shared) — a
  // root-level dataset/workflow is no longer listed twice.
  const treeItems = items
    .filter((a) => a.scope === 'personal' || a.scope === 'domain')
    .map((a) => ({ id: a.id, folder: a.folder ?? '/', name: a.name, scope: a.scope as 'personal' | 'domain' }));
  const personalNodes = folders.filter((f) => f.scope === 'personal').map((f) => ({ path: f.path }));
  const domainNodes = folders.filter((f) => f.scope === 'domain').map((f) => ({ path: f.path }));
  const mktItems = items.filter((a) => a.scope === 'marketplace');

  // Currently-checked ids = explicit item grants ∪ every feed item a granted folder covers IN
  // THAT GRANT'S LANE (so a folder grant renders as a fully-ticked folder — and a grant on
  // "My files" never ticks anything under "Domain files"). Workflows carry no folders, so the
  // Workflows picker manages item grants only.
  const managesFolders = kind !== 'workflows';
  const rootGrantable = kind === 'files';
  const grantList = system.grants[kind];
  const checked = checkedIdsFor(system, kind, treeItems, inFamily);
  // Every foldered item of the feed, whatever its id family — what a folder grant is COUNTED
  // against ("this grant currently contains 0 files").
  const laneItems = (feed?.items ?? [])
    .filter((a) => a.scope === 'personal' || a.scope === 'domain')
    .map((a) => ({ id: a.id, folder: a.folder ?? '/', scope: a.scope as 'personal' | 'domain' }));
  const outsideRefs = outsideFolders.map((f) => ({ path: f.path, scope: f.scope }));
  // Folder grants the tree cannot draw as ticks (outside the domain, empty, or a `/` this tree
  // has no row for). They are never removed by a tick elsewhere — only by their own ✕ / box.
  const protectedFolders = treeProtectedFolders(system, kind, treeItems, { outside: outsideRefs, rootGrantable });
  const emptyGranted = managesFolders ? emptyFolderGrants(system, kind, treeItems) : [];

  const onChange = (sel: FolderSelection) => {
    if (!canEdit) return;
    onCommit(applyFolderSelection(system, kind, sel, layerFor, {
      inFamily,
      manageFolders: managesFolders,
      // Removal is bounded by what the TREE could actually show — `treeItems`, NOT the whole
      // feed. Marketplace items live in the separate "+ Add from marketplace" picker and are
      // never tickable here, so counting them as listed made the first tick delete every
      // marketplace grant. Same reason the folders the tree cannot draw are passed as protected.
      listedItemIds: treeItems.map((a) => a.id),
      protectedFolders,
    }));
  };
  // An EMPTY folder (or lane) is granted as a folder, explicitly: there is no item to tick, so
  // the selection above can neither add nor remove it.
  const onToggleEmptyFolder = (f: { path: string; scope: 'personal' | 'domain' }, grant: boolean) => {
    if (!canEdit) return;
    onCommit(grant ? setFolderGrant(system, kind, f, false) : removeFolderGrant(system, kind, f));
  };

  // The granted chips (item grants + folder grants) shown below the tree with controls.
  const grantedItems = grantList.filter((g) => !g.folder && g.id && inFamily(g.id));
  const grantedFolders = managesFolders ? grantList.filter((g) => g.folder) : [];
  const cap = accessCap(system.safetyPreset);
  const scopeOf = (id: string): 'personal' | 'domain' | 'marketplace' => availOf(id)?.scope ?? 'personal';
  const mktGrantedIds = new Set(grantedItems.map((g) => g.id));
  // Folder grants the feed flagged as pointing OUTSIDE this system's domain (legacy). They are
  // NOT tree nodes (see `FolderNode`): they render here as read-only chips carrying a warning,
  // so the author can see why a foreign folder is attached and remove it deliberately instead
  // of discovering it at run time.
  const outsideKeys = new Set(outsideFolders.map((f) => `${f.scope}:${normaliseFolderPath(f.path)}`));
  const isOutside = (f: { path: string; scope: string }) =>
    outsideKeys.has(`${f.scope}:${normaliseFolderPath(f.path)}`);
  // The same honesty for an ITEM grant: an id the narrowed feed did not return is one this
  // picker cannot show or describe (`nameOf` falls back to the id). It is kept — the reconcile
  // protects it — and badged, so a bare id is never left unexplained. The wording says only
  // what is actually known: it is not in this view, which is usually another domain but can
  // also be an artifact that is gone.
  const isOutsideItem = (id: string) => !availOf(id);
  // WHY it is not in the view, when the server could tell (private to someone else · gone ·
  // another domain) — resolved as the caller, never naming a resource they cannot see.
  const warnings = warningIndex(feed?.grantWarnings);
  const itemWarning = (id: string) => warnings.get(grantWarningKey({ kind, id }));
  const folderWarning = (f: { path: string; scope: 'personal' | 'domain' }) =>
    warnings.get(grantWarningKey({ kind, folder: { path: f.path, scope: f.scope } }));
  // A folder grant that matches nothing today, said at the chip — with where the items of that
  // name actually are, when they are in the other lane. Shown to the BUILDER only. Not for an
  // output folder (empty until the first result is written) nor one this view cannot count.
  const emptyNote = (f: { path: string; scope: 'personal' | 'domain' }): string | null => {
    if (feed === null || isOutside(f) || isOutputFolder(system, kind, f)) return null;
    return zeroMatchWarning(kind, folderGrantCoverage(f, laneItems));
  };
  const addableMkt = mktItems.filter((a) => !mktGrantedIds.has(a.id));

  return (
    <div className="sb-resource">
      {hideLabel ? null : <div className="sb-field-label" style={{ margin: '4px 0' }}>{label}</div>}
      {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
      {feed === null ? (
        <p className="hint" style={{ marginTop: 0 }}>Loading…</p>
      ) : treeItems.length === 0 && folders.length === 0 ? (
        <p className="hint" style={{ marginTop: 0 }}>Nothing to grant — create or share {label.toLowerCase()} first.</p>
      ) : (
        <FolderTree
          variant="checkbox"
          personalNodes={personalNodes}
          domainNodes={domainNodes}
          items={treeItems}
          checkedIds={checked}
          onChange={onChange}
          rootGranted={rootGrantable ? rootGrantedScopes(system, kind) : undefined}
          emptyFolderGrants={emptyGranted}
          onToggleEmptyFolder={managesFolders && canEdit ? onToggleEmptyFolder : undefined}
          // Files are grantable at ANY granularity: a single file (leaf tick), a
          // folder, or "All" (the `/` root row). Leaves are selectable for every
          // kind; the extra "All …" root row is a Files convenience for granting a
          // whole scope (incl. files that sit at the root with no named subfolder).
          rootGrantable={rootGrantable}
        />
      )}

      {/* Granted-resource controls — access level + (data) medallion layer. */}
      {(grantedItems.length > 0 || grantedFolders.length > 0) ? (
        <div className="sb-chips" style={{ marginTop: 8 }}>
          {grantedFolders.map((g) => (
            <span key={`f:${g.folder!.scope}:${g.folder!.path}`} className="sb-chip granted" style={{ gap: 8 }}>
              <span>
                📁 {g.folder!.path === '/' ? 'All' : g.folder!.path}
                <span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(g.folder!.scope === 'domain' ? 'shared' : 'mine')}</span>
                {isOutputFolder(system, kind, g.folder!) ? (
                  <span className="badge muted" style={{ marginLeft: 6 }} title="Declared under “Where the results go” — the team writes its results here.">
                    results go here
                  </span>
                ) : isOutside(g.folder!) ? (
                  <span
                    className="badge warn"
                    style={{ marginLeft: 6 }}
                    title="This folder belongs to another domain than this team. The grant still works, but it was made before grants were scoped to the team's domain — remove it unless you meant it."
                  >
                    outside this domain
                  </span>
                ) : null}
                {folderWarning(g.folder!) ? <GrantWarningNote warning={folderWarning(g.folder!)!} /> : null}
                {emptyNote(g.folder!) ? (
                  <span className="hint" role="note" style={{ display: 'block', marginTop: 2, color: 'var(--warn, #b7791f)' }}>
                    {emptyNote(g.folder!)}
                  </span>
                ) : null}
              </span>
              {/* Files are folder-granted only, so the folder chip carries the SAME access
                  selector item grants use — this is the only place a Files write can be set.
                  `cap` (from the system safety preset) bounds it exactly like every kind.
                  READ-ONLY for an out-of-domain folder: this picker cannot show what is inside
                  it, so raising its capability would be granting write over contents the author
                  cannot inspect. Removing it (✕) stays available — that only ever reduces. */}
              <AccessLevelSelect
                cap={cap}
                capability={g.capability}
                canEdit={canEdit && !isOutside(g.folder!)}
                onLevel={(l) => onCommit(setFolderGrantLevel(system, kind, g.folder!, l))}
              />
              {canEdit ? (
                <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeFolderGrant(system, kind, g.folder!))}>✕</button>
              ) : null}
            </span>
          ))}
          {grantedItems.map((g) => (
            <span key={g.id} className="sb-chip granted" style={{ gap: 8 }}>
              <span>
                {nameOf(g.id)}
                {itemWarning(g.id) ? (
                  <GrantWarningNote warning={itemWarning(g.id)!} />
                ) : isOutsideItem(g.id) ? (
                  <span
                    className="badge warn"
                    style={{ marginLeft: 6 }}
                    title="This artifact is not in this team's domain — or is no longer visible here. The grant still works at run time (it resolves as whoever runs the team), but this picker cannot show you what it is. Remove it unless you meant it."
                  >
                    outside this domain
                  </span>
                ) : (
                  <span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(scopeKeyOf(scopeOf(g.id)))}</span>
                )}
              </span>
              <AccessLevelSelect
                cap={cap}
                capability={g.capability}
                canEdit={canEdit}
                onLevel={(l) => onCommit(setArtifactGrantLevel(system, kind, g.id, l))}
              />
              {kind === 'data' ? (
                <LayerToggle
                  layer={g.layer ?? highestLayer(layersOf(g.id)) ?? 'gold'}
                  built={layersOf(g.id)}
                  canEdit={canEdit}
                  onPick={(l) => onCommit(setDataGrantLayer(system, g.id, l))}
                />
              ) : null}
              {canEdit ? (
                <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeArtifactGrant(system, kind, g.id))}>✕</button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {kind === 'files' ? (
        <p className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
          Tick a <strong>single file</strong>, a whole <strong>folder</strong> (covers files added later), or <strong>All</strong>.
          Access follows the file store’s own permissions at run time.
        </p>
      ) : null}

      {/* Marketplace supplementary picker — foldered trees only cover personal + domain. */}
      {kind !== 'files' && canEdit && mktItems.length > 0 ? (
        !mktOpen ? (
          <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setMktOpen(true)}>
            + Add from marketplace
          </button>
        ) : (
          <div className="sb-resource-picker">
            {addableMkt.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>Nothing left to add.</p>
            ) : (
              <div className="sb-picker-list">
                {addableMkt.map((a) => (
                  <button
                    key={a.id}
                    className="sb-picker-row"
                    title={a.id}
                    onClick={() => onCommit(setArtifactGrantLevel(system, kind, a.id, cap.default, layerFor(a.id)))}
                  >
                    +<span>{a.name}</span><span className="badge muted">{scopeLabel(scopeKeyOf(a.scope))}</span>
                  </button>
                ))}
              </div>
            )}
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setMktOpen(false)}>Done</button>
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * A small reusable "pick an existing folder OR ＋ New folder" control. The folder list
 * is the kind's DLS-scoped folders (from the grants-available feed); a new folder is
 * just a typed path that materialises when the first artifact is written there (folders
 * are path-derived — there is no standalone folder object). Emits the chosen `path`.
 * Reusable beyond Outputs — the same affordance can back a grant picker's new-path input.
 */
export function NewFolderField({
  folders, value, canEdit, onChange, scope,
}: {
  /** Existing folder paths available in the chosen scope. */
  folders: string[];
  value: string;
  canEdit: boolean;
  onChange: (path: string) => void;
  scope: 'personal' | 'domain';
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const commitNew = () => {
    const p = normaliseFolderPath(draft);
    if (p && p !== '/') { onChange(p); setAdding(false); setDraft(''); }
  };
  if (adding) {
    return (
      <span className="sb-out-newfolder" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className="hint" style={{ marginTop: 0 }}>{scope === 'domain' ? 'Domain' : 'My'} /</span>
        <input
          type="text"
          autoFocus
          value={draft}
          placeholder="reports/weekly"
          disabled={!canEdit}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNew(); } if (e.key === 'Escape') setAdding(false); }}
          style={{ width: 160 }}
        />
        <button type="button" className="btn ghost sm" disabled={!canEdit || !draft.trim()} onClick={commitNew}>Add</button>
        <button type="button" className="btn ghost sm" onClick={() => { setAdding(false); setDraft(''); }}>Cancel</button>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <select
        className="sb-out-folder"
        value={value}
        disabled={!canEdit}
        onChange={(e) => onChange(e.target.value)}
        style={{ minWidth: 140 }}
      >
        <option value="/">/ (root)</option>
        {folders.filter((f) => f !== '/').map((f) => <option key={f} value={f}>{f}</option>)}
        {value !== '/' && !folders.includes(value) ? <option value={value}>{value}</option> : null}
      </select>
      <button type="button" className="btn ghost sm" disabled={!canEdit} onClick={() => setAdding(true)}>＋ New folder</button>
    </span>
  );
}

/**
 * The inline explanation of the agent-system-wide access cap. Reads the system's
 * safety preset and says, in one honest line, HOW the per-item selector is bounded:
 * locked at the extremes (read-only / full-in-scope), downgrade-only in the middle.
 */
export function AccessCapNote({ cap, preset }: { cap: AccessCap; preset: SafetyPreset }) {
  const msg = cap.locked
    ? cap.reason
    : preset === 'read-bounded'
      ? 'The system allows writes in-scope — each item defaults to Read + write; you may downgrade any item, never go above it.'
      : 'The system default is Read + propose — every write is held for a human to approve before it runs; nothing is written directly. Each item defaults to Read + propose; you may downgrade to Read-only, never grant direct write above the system setting.';
  return (
    <div className={`badge ${cap.locked ? 'warn' : 'muted'}`} role="note" style={{ display: 'block', padding: '8px 10px', marginBottom: 10, lineHeight: 1.4, whiteSpace: 'normal' }}>
      {cap.locked ? '🔒 ' : 'ℹ '}{msg} Change it under <strong>What this team is allowed to do</strong> above.
    </div>
  );
}

/** Map the grants-available `scope` string to a core `ScopeKey` for `scopeLabel`. */
function scopeKeyOf(scope: 'personal' | 'domain' | 'marketplace'): ScopeKey {
  return scope === 'domain' ? 'shared' : scope === 'marketplace' ? 'marketplace' : 'mine';
}

/** Per-level tooltip — what each access level actually grants, in plain words. */
const ACCESS_HINTS: Record<AccessLevel, string> = {
  'read-only': 'Can read only — never changes anything.',
  'read-propose': 'Every write is held for a human to approve before it runs — nothing is written directly.',
  'read-write': 'Can change directly — no approval step.',
};

/**
 * The per-item ACCESS-LEVEL selector — a labelled three-option SEGMENTED control
 * (Read-only · Read + propose · Read + write) CAPPED by the agent-system-wide safety
 * preset (`cap`). It offers only the levels at or below the system ceiling.
 *
 * Fully CONTROLLED — the highlighted option is derived ONLY from the persisted
 * `capability` prop (clamped to the cap), never from local optimistic state, so there
 * is NO flicker or press-then-revert repaint: the commit awaits the reload and the
 * segment repaints once, cleanly, to the new value. The active option is always shown
 * filled with its text label, so the current level is unambiguous at a glance.
 *
 * When the system is LOCKED (read-only / full-in-scope) the control is non-interactive
 * but still legible: the fixed level stays highlighted, dimmed, with a 🔒 and the reason.
 */
export function AccessLevelSelect({
  cap, capability, canEdit, onLevel,
}: {
  cap: AccessCap;
  capability: string;
  canEdit: boolean;
  onLevel: (level: AccessLevel) => void;
}) {
  const current = clampAccess(capabilityToAccess(capability as Parameters<typeof capabilityToAccess>[0]), cap);
  const options = allowedAccessLevels(cap);
  const interactive = canEdit && !cap.locked;
  return (
    <span
      className={`sb-access-seg${cap.locked ? ' locked' : ''}`}
      role="radiogroup"
      aria-label="Access level"
      title={cap.locked ? cap.reason : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
    >
      {options.map((l) => {
        const active = l === current;
        return (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!interactive}
            title={ACCESS_HINTS[l] + (cap.locked ? ` — ${cap.reason}` : '')}
            className={`sb-access-seg-btn${active ? ' active' : ''}`}
            onClick={() => interactive && !active && onLevel(l)}
          >
            {cap.locked && active ? '🔒 ' : ''}{ACCESS_LABELS[l]}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Bronze · Silver · Gold segmented selector for ONE granted dataset (DATA grants
 * only). Renders ONLY the medallion layers that are actually BUILT for this dataset
 * — so a user can never pick an unbuilt (unqueryable) layer. Hidden entirely when
 * the dataset exposes a single layer (nothing to choose). Gold, when built, is the
 * curated serving default; picking silver/bronze routes the team's discovery + reads
 * to that layer's physical table.
 */
const LAYER_ORDER: DataLayer[] = ['bronze', 'silver', 'gold'];
export function LayerToggle({
  layer, built, canEdit, onPick,
}: {
  layer: DataLayer;
  /** The dataset's built medallion layers (from the grant-available feed). */
  built: DataLayer[];
  canEdit: boolean;
  onPick: (layer: DataLayer) => void;
}) {
  const choices = LAYER_ORDER.filter((l) => built.includes(l));
  // Nothing to choose (0 or 1 built layer) → no selector at all.
  if (choices.length < 2) return null;
  return (
    <span className="sb-layer" role="group" aria-label="Medallion layer" style={{ display: 'inline-flex', gap: 4 }}>
      {choices.map((l) => (
        <button
          key={l}
          type="button"
          className={`btn ghost sm${l === layer ? ' active' : ''}`}
          aria-pressed={l === layer}
          disabled={!canEdit}
          title={`Read the ${l} layer`}
          onClick={() => canEdit && l !== layer && onPick(l)}
        >
          {l.charAt(0).toUpperCase() + l.slice(1)}
        </button>
      ))}
    </span>
  );
}

export function ResourcePicker({
  systemId, system, kind, feedKind, label, canEdit, onCommit, hideLabel,
}: {
  systemId: string;
  system: System;
  /** An id-carrying grant kind (Files is handled separately by FolderResourcePicker).
   *  `plan` holds Operating Manual (`manual:<scope>`) grants. */
  kind: 'data' | 'knowledge' | 'connections' | 'metrics' | 'plan';
  /** The `…/grants/available?kind=` feed to browse — `metric` (singular) for metrics;
   *  `operating-manual` for the plan feed. */
  feedKind: 'data' | 'knowledge' | 'connections' | 'metric' | 'operating-manual';
  label: string;
  /** Suppress the internal category label — the caller renders a prominent one. */
  hideLabel?: boolean;
  canEdit: boolean;
  onCommit: (next: System) => void;
}) {
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [warnings, setWarnings] = useState<Map<string, GrantWarning>>(new Map());
  const [loadErr, setLoadErr] = useState('');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let alive = true;
    setLoadErr('');
    fetch(`/api/agents/systems/${systemId}/grants/available?kind=${feedKind}`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load');
        if (alive) {
          setAvailable(body.items as Available[]);
          setWarnings(warningIndex((body as AvailableFeed).grantWarnings));
        }
      })
      .catch((e) => { if (alive) setLoadErr((e as Error).message); });
    return () => { alive = false; };
  }, [systemId, feedKind]);

  const granted = system.grants[kind];
  const availOf = (id: string) => available?.find((a) => a.id === id);
  const nameOf = (id: string) =>
    availOf(id)?.name
    ?? (id.includes('_') ? id.split('_').slice(1).join('_') : id);
  const scopeOf = (id: string): 'personal' | 'domain' | 'marketplace' => availOf(id)?.scope ?? 'personal';
  /** Built medallion layers for a granted dataset (empty until `available` loads). */
  const layersOf = (id: string): DataLayer[] => availOf(id)?.layers ?? [];
  const grantedIds = new Set(granted.map((g) => g.id));
  const addable = (available ?? []).filter((a) => !grantedIds.has(a.id));
  const q = search.trim().toLowerCase();
  const shown = q ? addable.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : addable;
  // Metrics + Plan (Operating Manual) are read-only (no agent author path) — cap the
  // selector at read-only regardless of the system posture; other kinds obey the full cap.
  const readOnlyKind = kind === 'metrics' || kind === 'plan';
  const baseCap = accessCap(system.safetyPreset);
  const cap: AccessCap = readOnlyKind
    ? { ...baseCap, ceiling: 'read-only', default: 'read-only', reason: baseCap.reason || `${label} is read-only.` }
    : baseCap;

  return (
    <div className="sb-resource">
      {hideLabel ? null : <div className="sb-field-label" style={{ margin: '4px 0' }}>{label}</div>}
      {loadErr ? <div className="error" style={{ marginBottom: 6 }}>{loadErr}</div> : null}
      <div className="sb-chips">
        {granted.length === 0 ? <span className="hint" style={{ marginTop: 0 }}>None yet.</span> : null}
        {granted.map((g) => (
          <span key={g.id} className="sb-chip granted" style={{ gap: 8 }}>
            <span>
              {nameOf(g.id)}
              {warnings.get(`${kind}:${g.id}`) ? (
                <GrantWarningNote warning={warnings.get(`${kind}:${g.id}`)!} />
              ) : (
                <span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(scopeKeyOf(scopeOf(g.id)))}</span>
              )}
            </span>
            {readOnlyKind ? null : (
              <AccessLevelSelect
                cap={cap}
                capability={g.capability}
                canEdit={canEdit}
                onLevel={(l) => onCommit(setArtifactGrantLevel(system, kind, g.id, l))}
              />
            )}
            {kind === 'data' ? (
              <LayerToggle
                layer={g.layer ?? highestLayer(layersOf(g.id)) ?? 'gold'}
                built={layersOf(g.id)}
                canEdit={canEdit}
                onPick={(l) => onCommit(setDataGrantLayer(system, g.id, l))}
              />
            ) : null}
            {canEdit ? (
              <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeArtifactGrant(system, kind, g.id))}>✕</button>
            ) : null}
          </span>
        ))}
      </div>
      {kind === 'data' && granted.length > 0 ? (
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          Which refined layer this team reads — Gold is the curated default.
        </p>
      ) : null}
      {kind === 'plan' ? (
        <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
          A granted manual is loaded on demand via the governed <span className="mono">get_operating_manual</span> tool, scope-checked as you. Nothing is auto-injected — grant the Domain manual to have the team load it explicitly.
        </p>

      ) : null}
      {canEdit ? (
        !open ? (
          <button className="btn ghost sm" style={{ marginTop: 6 }} disabled={available === null} onClick={() => setOpen(true)}>
            + Add {label.toLowerCase()}
          </button>
        ) : (
          <div className="sb-resource-picker">
            {addable.length > 6 ? (
              <input
                type="text"
                autoFocus
                placeholder={`Search ${label.toLowerCase()}…`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ width: '100%', marginBottom: 8 }}
              />
            ) : null}
            {shown.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                {addable.length === 0 ? `Nothing to add — create or share ${label.toLowerCase()} first.` : 'No matches.'}
              </p>
            ) : (
              <div className="sb-picker-list">
                {shown.map((a) => (
                  <button
                    key={a.id}
                    className="sb-picker-row"
                    title={a.id}
                    onClick={() =>
                      // A newly-granted item adopts the system posture's DEFAULT access
                      // level (the author can then downgrade it). DATA grants default to
                      // the HIGHEST built layer; non-data kinds ignore the layer arg.
                      onCommit(setArtifactGrantLevel(system, kind, a.id, cap.default, highestLayer(a.layers) ?? 'gold'))
                    }
                  >
                    +<span>{a.name}</span><span className="badge muted">{scopeLabel(scopeKeyOf(a.scope))}</span>
                  </button>
                ))}
              </div>
            )}
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => { setOpen(false); setSearch(''); }}>Done</button>
          </div>
        )
      ) : null}
    </div>
  );
}
