/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import type { System, DataLayer, SafetyPreset } from '@/lib/agents/system-schema';
import {
  setArtifactGrant, removeArtifactGrant, setDataGrantLayer,
  setFolderGrant, removeFolderGrant, setArtifactGrantLevel, setFolderGrantLevel,
} from '@/lib/agents/simple-edit';
import {
  accessCap, allowedAccessLevels, capabilityToAccess, clampAccess,
  ACCESS_LABELS, type AccessLevel, type AccessCap,
} from '@/lib/agents/access-levels';
import { isWorkflowId } from '@/lib/agents/resource-groups';
import { scopeLabel, type ScopeKey } from '@/lib/core/scopes';
import FolderTree, { type FolderSelection } from '@/components/core/FolderTree';
import { itemsUnderFolder, normaliseFolderPath } from '@/lib/core/folders';

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
export type FolderNode = { path: string; scope: 'personal' | 'domain' };
export type AvailableFeed = { items: Available[]; folders?: FolderNode[] };

/** Highest built layer of a dataset (Gold > Silver > Bronze), or null if none built. */
export function highestLayer(layers: DataLayer[] | undefined): DataLayer | null {
  if (!layers || layers.length === 0) return null;
  if (layers.includes('gold')) return 'gold';
  if (layers.includes('silver')) return 'silver';
  if (layers.includes('bronze')) return 'bronze';
  return null;
}

/** The folder grants of a kind currently on the system (each `{path,scope}`). */
function folderGrantsOf(system: System, kind: 'data' | 'knowledge' | 'files'): FolderNode[] {
  return system.grants[kind]
    .filter((g) => g.folder)
    .map((g) => ({ path: g.folder!.path, scope: g.folder!.scope }));
}

/**
 * Apply a FolderTree {@link FolderSelection} onto the system for one foldered kind,
 * as a minimal diff that PRESERVES existing per-item write capabilities. Folder grants
 * and item grants both default to Read on first tick; the write toggle below the tree
 * is what lifts a specific grant. Files carry NO per-item list, so only their folder
 * grants are applied (individual file ticks are inert — surfaced in the UI hint).
 */
export function applyFolderSelection(
  system: System,
  kind: 'data' | 'knowledge' | 'files',
  sel: FolderSelection,
  itemLayer: (id: string) => DataLayer,
  // When the knowledge feed is split into Workflows vs Knowledge, each picker
  // reconciles ONLY its own item family so it never removes the other's grants.
  // `manageFolders` is false for the Workflows picker (workflows carry no folders).
  opts: { inFamily?: (id: string) => boolean; manageFolders?: boolean } = {},
): System {
  const inFamily = opts.inFamily ?? (() => true);
  const manageFolders = opts.manageFolders ?? true;
  let next = system;
  const key = (f: { path: string; scope: string }) => `${f.scope}:${normaliseFolderPath(f.path)}`;

  // ── Folder grants: add newly-selected, remove de-selected. ──
  if (manageFolders) {
    const wantFolders = new Set(sel.folderGrants.map(key));
    const haveFolders = folderGrantsOf(system, kind);
    for (const f of sel.folderGrants) {
      if (!haveFolders.some((h) => key(h) === key(f))) next = setFolderGrant(next, kind, f, false);
    }
    for (const h of haveFolders) {
      if (!wantFolders.has(key(h))) next = removeFolderGrant(next, kind, h);
    }
  }

  // ── Item grants (all foldered kinds, INCLUDING files — a single file can be
  //    granted by its id, exactly like a dataset or a knowledge entry). ──
  {
    const wantItems = new Set(sel.itemGrants.filter(inFamily));
    const haveItems = next.grants[kind].filter((g) => !g.folder && g.id && inFamily(g.id)).map((g) => g.id);
    for (const id of wantItems) {
      if (!haveItems.includes(id)) next = setArtifactGrant(next, kind, id, false, itemLayer(id));
    }
    for (const id of haveItems) {
      if (!wantItems.has(id)) next = removeArtifactGrant(next, kind, id);
    }
  }
  return next;
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
  systemId, system, kind, label, canEdit, onCommit, idFamily, hideLabel,
}: {
  systemId: string;
  system: System;
  kind: 'data' | 'knowledge' | 'files';
  label: string;
  canEdit: boolean;
  onCommit: (next: System) => void;
  /** Knowledge feed only — narrow to workflows (`wf_…`) or knowledge docs (everything else). */
  idFamily?: 'workflow' | 'knowledge';
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

  // Split the shared knowledge feed so Workflows (own Plan-Items member) and Knowledge
  // (Context) each show ONLY their own item family. Other kinds pass every item.
  const inFamily = (id: string) =>
    !idFamily ? true : idFamily === 'workflow' ? isWorkflowId(id) : !isWorkflowId(id);
  const items = (feed?.items ?? []).filter((a) => inFamily(a.id));
  const folders = feed?.folders ?? [];
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

  // Currently-checked ids = explicit item grants ∪ every feed item under a granted folder
  // (so a folder grant renders as a fully-ticked folder). Files: only folders drive checks.
  // Workflows carry no folders, so the Workflows picker manages item grants only.
  const managesFolders = idFamily !== 'workflow';
  const grantList = system.grants[kind];
  const itemGrantIds = new Set(grantList.filter((g) => !g.folder && g.id && inFamily(g.id)).map((g) => g.id));
  const checked = new Set<string>(itemGrantIds);
  for (const g of grantList) {
    if (!g.folder) continue;
    for (const it of itemsUnderFolder(g.folder.path, treeItems)) checked.add(it.id);
  }

  const onChange = (sel: FolderSelection) => {
    if (!canEdit) return;
    onCommit(applyFolderSelection(system, kind, sel, layerFor, { inFamily, manageFolders: managesFolders }));
  };

  // The granted chips (item grants + folder grants) shown below the tree with controls.
  const grantedItems = grantList.filter((g) => !g.folder && g.id && inFamily(g.id));
  const grantedFolders = managesFolders ? grantList.filter((g) => g.folder) : [];
  const cap = accessCap(system.safetyPreset);
  const scopeOf = (id: string): 'personal' | 'domain' | 'marketplace' => availOf(id)?.scope ?? 'personal';
  const mktGrantedIds = new Set(grantedItems.map((g) => g.id));
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
          checkedIds={[...checked]}
          onChange={onChange}
          // Files are grantable at ANY granularity: a single file (leaf tick), a
          // folder, or "All" (the `/` root row). Leaves are selectable for every
          // kind; the extra "All …" root row is a Files convenience for granting a
          // whole scope (incl. files that sit at the root with no named subfolder).
          rootGrantable={kind === 'files'}
        />
      )}

      {/* Granted-resource controls — access level + (data) medallion layer. */}
      {(grantedItems.length > 0 || grantedFolders.length > 0) ? (
        <div className="sb-chips" style={{ marginTop: 8 }}>
          {grantedFolders.map((g) => (
            <span key={`f:${g.folder!.scope}:${g.folder!.path}`} className="sb-chip granted" style={{ gap: 8 }}>
              <span>📁 {g.folder!.path === '/' ? 'All' : g.folder!.path}<span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(g.folder!.scope === 'domain' ? 'shared' : 'mine')}</span></span>
              {/* Files are folder-granted only, so the folder chip carries the SAME access
                  selector item grants use — this is the only place a Files write can be set.
                  `cap` (from the system safety preset) bounds it exactly like every kind. */}
              <AccessLevelSelect
                cap={cap}
                capability={g.capability}
                canEdit={canEdit}
                onLevel={(l) => onCommit(setFolderGrantLevel(system, kind, g.folder!, l))}
              />
              {canEdit ? (
                <button className="sb-chip-x" title="Remove" onClick={() => onCommit(removeFolderGrant(system, kind, g.folder!))}>✕</button>
              ) : null}
            </span>
          ))}
          {grantedItems.map((g) => (
            <span key={g.id} className="sb-chip granted" style={{ gap: 8 }}>
              <span>{nameOf(g.id)}<span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(scopeKeyOf(scopeOf(g.id)))}</span></span>
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
        if (alive) setAvailable(body.items as Available[]);
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
            <span>{nameOf(g.id)}<span className="badge muted" style={{ marginLeft: 6 }}>{scopeLabel(scopeKeyOf(scopeOf(g.id)))}</span></span>
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
