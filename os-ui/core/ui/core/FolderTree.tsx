/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    FolderTree — the shared folder tree, in nav, checkbox and picker variants
 * USER STORY: As a user organising or granting artifacts I want the same folder tree in every
 *             foldered tab, whether I am browsing, ticking folders to grant, or choosing where to
 *             move something, so that folders behave the same everywhere.
 * ARCHITECTURE:
 *   - Pure UI, with no tab-specific logic. Callers pass folder rows (`personalNodes`,
 *     `domainNodes`), already-scoped `items`, a `renderLeaf` and handlers. The tree and
 *     tri-state maths come from `@core/kernel/folders`. Used across Files, Data, Knowledge,
 *     Metrics, Workflows, Software, Agents and Connections.
 *   - `variant="nav"` is the rail (select, create, move, rename, archive, restore, delete).
 *     `variant="checkbox"` emits a normalised `{ folderGrants, itemGrants }`: a fully ticked
 *     folder becomes a folder grant that also covers future items. `variant="picker"` selects
 *     one folder and emits `{ path, scope }` on "Move here".
 *   - Renders a personal root and a domain root (`roots` hides either one). Offering
 *     domain-folder creation follows `canCreateDomain`. The server gate in `createFolder` is the
 *     real check.
 *   - `FolderPickerModal` wraps the picker variant in a dialog that closes on Escape, backdrop
 *     click or ×.
 * I18N:       converted (wave 4) — its own words from `common.folders.*`; folder and item names are user content.
 */
'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onEscape, isBackdropClick } from '@core/kernel/overlay-dismiss';
import { useTranslations } from '@core/i18n/client';
import {
  buildTree,
  impliedFolderPaths,
  triState,
  itemsUnderFolder,
  normaliseFolderPath,
  visibleFolderRoots,
  computeFolderSelection,
  type FolderPathNode,
  type FolderTreeNode,
} from '@core/kernel/folders';

type RootScope = 'personal' | 'domain';

export type FolderTreeItem = {
  id: string;
  folder: string;
  name?: string;
  /**
   * Which root this item belongs to. OPTIONAL and backward-compatible: when omitted
   * (the historical shape) the item is shown under BOTH roots as before. When set, the
   * item renders ONLY under its own root — so a root-level ('/') item granted in one
   * scope is no longer duplicated across the "My" and "Shared" trees.
   */
  scope?: RootScope;
};

export type FolderGrant = { path: string; scope: 'personal' | 'domain' };
export type FolderSelection = { folderGrants: FolderGrant[]; itemGrants: string[] };

type CommonProps = {
  /** Folder rows for the personal root. */
  personalNodes: FolderPathNode[];
  /** Folder rows for the domain root. */
  domainNodes?: FolderPathNode[];
  /** Already-DLS-scoped items across both roots (each carries a `folder` path). */
  items: FolderTreeItem[];
  /** Render one leaf item (the tab decides the row: filename, doc title, …). */
  renderLeaf?: (item: FolderTreeItem) => ReactNode;
  /** Labels for the two roots (defaults: "My folders" / "Domain folders"). */
  personalLabel?: string;
  domainLabel?: string;
  /**
   * Which root sections to render — the active My/Domain scope decides this. When a
   * root is omitted, its whole section (header included) is hidden, so the inactive
   * scope's empty root never shows as a bare "Domain folders" / "My folders" heading.
   * Defaults to BOTH roots for backward-compatibility. An active-but-empty root still
   * renders (so a user with no folders yet can create their first one).
   */
  roots?: RootScope[];
  /**
   * May the viewer CREATE a DOMAIN folder? Creating domain-level structure is a
   * domain_admin+ act (mirrors the server gate in `createFolder`), so a builder/
   * creator must not be offered the affordance. Defaults to `true` for backward-
   * compatibility; callers that know the viewer's role pass `false` for non-admins
   * to hide/disable the domain-scope "New folder" buttons. Personal-scope creation
   * is always allowed (a user owns their own tree).
   */
  canCreateDomain?: boolean;
};

/** The folder-row handle passed to every lifecycle callback — the path (always) plus
 *  the registry `id` + `archived` state (real rows only; synthetic folders omit `id`). */
export type FolderRef = { scope: RootScope; path: string; id?: string; archived?: boolean };

type NavProps = CommonProps & {
  variant: 'nav';
  /** The currently-selected folder path (within the active root). */
  selectedPath?: string;
  onSelect?: (scope: RootScope, path: string) => void;
  /** Create a subfolder under `parentPath` in `scope`. */
  onCreate?: (scope: RootScope, parentPath: string) => void;
  /** Move a folder (its ••• menu) — reparents the row AND its member items. */
  onMove?: (ref: FolderRef) => void;
  /** Rename a folder in place — changes its LEAF name (same parent), keeping the row.
   *  `newName` is the raw user input (the caller normalises + builds the new path). */
  onRename?: (ref: FolderRef, newName: string) => void;
  /** Archive a folder (cascades to the items inside). Real rows only. */
  onArchive?: (ref: FolderRef) => void;
  /** Restore an archived folder (cascades). Real, archived rows only. */
  onRestore?: (ref: FolderRef) => void;
  /** Physically delete an archived folder (cascades). Real, archived rows only. */
  onDelete?: (ref: FolderRef) => void;
};

type CheckboxProps = CommonProps & {
  variant: 'checkbox';
  /** Currently-checked item ids (controlled). */
  checkedIds: string[];
  onChange?: (next: FolderSelection) => void;
  /**
   * Whether LEAF items get their own checkbox. Default `true`. Set `false` for a
   * kind that grants by FOLDER only (e.g. Files, whose per-file ticks are inert):
   * leaves render display-only so there are no dead checkboxes, while folders stay
   * tickable (folder-granting doesn't depend on leaf checkboxes existing).
   */
  leavesSelectable?: boolean;
  /**
   * Whether the ROOT `/` is itself a grantable folder. Default `false` (root-level
   * items emit individually, as before). Set `true` for a folder-only kind (Files)
   * so a tickable "All …" root row appears and ticking it emits a single `/` folder
   * grant — the ONLY way to grant files that live at the root with no subfolder.
   */
  rootGrantable?: boolean;
  /**
   * The roots that currently HOLD the catch-all `/` grant (only read with `rootGrantable`).
   * The "All …" row is ticked from this — not from "every item happens to be ticked" — and a
   * root collapses to `/` only when it is listed here or its "All …" row was just ticked.
   */
  rootGranted?: RootScope[];
  /**
   * Granted folders that hold NO item right now. A tick is drawn from the items under a folder,
   * so without this a granted empty folder renders unticked.
   */
  emptyFolderGrants?: FolderGrant[];
  /**
   * Grant / un-grant a folder that holds no item (a late-bound grant: it covers what is filed
   * there later). Absent, the checkbox of an empty folder is disabled and says why — it used to
   * be a live-looking control that did nothing.
   */
  onToggleEmptyFolder?: (folder: FolderGrant, grant: boolean) => void;
};

type PickerProps = CommonProps & {
  variant: 'picker';
  /** Called with the chosen destination when the user clicks "Move here". */
  onConfirm: (dest: { path: string; scope: RootScope }) => void;
  /** Called when the user dismisses without choosing. */
  onCancel: () => void;
  /** Async callback to create a new folder in `scope` at `path` (mirrors nav onCreate). */
  onCreate?: (scope: RootScope, path: string) => Promise<void>;
};

export type FolderTreeProps = NavProps | CheckboxProps | PickerProps;

// ------------------------------------------------------------------- utils --

const INDENT = 16;

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-block',
        width: 12,
        transition: 'transform 120ms ease',
        transform: open ? 'rotate(90deg)' : 'none',
        color: 'var(--text-faint)',
        fontSize: 10,
      }}
    >
      ▶
    </span>
  );
}

/** The tri-state checkbox — a native checkbox with the indeterminate flag set
 *  imperatively via a ref callback (React has no `indeterminate` prop). */
function TriBox({
  state,
  onToggle,
  label,
  disabled,
  title,
}: {
  state: 'none' | 'some' | 'all';
  onToggle: () => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={state === 'all'}
      ref={(el) => {
        if (el) el.indeterminate = state === 'some';
      }}
      onChange={onToggle}
      disabled={disabled}
      title={title}
      style={{ accentColor: 'var(--gold-deep)', cursor: disabled ? 'not-allowed' : 'pointer' }}
    />
  );
}


// -------------------------------------------------------------- one subtree --

function FolderRow({
  node,
  depth,
  scope,
  props,
  itemsByFolder,
  allItems,
  checked,
  emit,
  pickerSelected,
  onPickerSelect,
}: {
  node: FolderTreeNode;
  depth: number;
  scope: RootScope;
  props: FolderTreeProps;
  itemsByFolder: Map<string, FolderTreeItem[]>;
  allItems: FolderTreeItem[];
  checked: Set<string>;
  emit: (nextChecked: Set<string>, rootOn?: boolean) => void;
  pickerSelected?: { path: string; scope: RootScope } | null;
  onPickerSelect?: (dest: { path: string; scope: RootScope }) => void;
}) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(depth < 1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creatingHere, setCreatingHere] = useState(false);

  const directItems = itemsByFolder.get(node.path) ?? [];
  const hasChildren = node.children.length > 0 || directItems.length > 0;

  const underIds = useMemo(
    () => itemsUnderFolder(node.path, allItems).map((i) => i.id),
    [node.path, allItems],
  );

  const nav = props.variant === 'nav' ? props : null;
  const box = props.variant === 'checkbox' ? props : null;
  const picker = props.variant === 'picker' ? props : null;

  const isSelected =
    nav?.selectedPath !== undefined && normaliseFolderPath(nav.selectedPath) === node.path;
  const isPickerSelected =
    picker !== null &&
    pickerSelected?.path === node.path &&
    pickerSelected?.scope === scope;

  // A folder with no item under it cannot be ticked through its items. It is granted (or not)
  // as a folder, through `onToggleEmptyFolder`; without that handler the box is disabled.
  const isEmpty = underIds.length === 0;
  const emptyGranted =
    !!box && isEmpty && (box.emptyFolderGrants ?? []).some((f) => f.scope === scope && normaliseFolderPath(f.path) === node.path);
  const folderState = isEmpty ? (emptyGranted ? 'all' : 'none') : triState(node.path, checked, underIds);

  function toggleFolder() {
    if (isEmpty) {
      box?.onToggleEmptyFolder?.({ path: node.path, scope }, !emptyGranted);
      return;
    }
    const state = triState(node.path, checked, underIds);
    const next = new Set(checked);
    if (state === 'all') {
      for (const id of underIds) next.delete(id);
    } else {
      for (const id of underIds) next.add(id);
    }
    emit(next);
  }

  const handleNewFolderInPicker = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!picker?.onCreate) return;
    const name = window.prompt(t('folders.newFolderPrompt'));
    if (!name?.trim()) return;
    const full = normaliseFolderPath(
      node.path === '/' ? `/${name.trim()}` : `${node.path}/${name.trim()}`,
    );
    setCreatingHere(true);
    try {
      await picker.onCreate(scope, full);
      // Auto-select the newly created folder.
      onPickerSelect?.({ path: full, scope });
      setOpen(true);
    } finally {
      setCreatingHere(false);
    }
  }, [picker, node.path, scope, onPickerSelect, t]);

  const rowClickHandler = nav
    ? () => nav.onSelect?.(scope, node.path)
    : picker
      ? () => onPickerSelect?.({ path: node.path, scope })
      : undefined;

  return (
    <div>
      <div
        className={`folder-row${isSelected || isPickerSelected ? ' is-selected' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 8 + depth * INDENT,
          paddingRight: 8,
          height: 32,
          borderRadius: 8,
          cursor: nav || picker ? 'pointer' : 'default',
          background: isSelected || isPickerSelected ? 'var(--gold-soft)' : 'transparent',
          color: isSelected || isPickerSelected ? 'var(--gold-text)' : 'var(--text)',
        }}
        onClick={rowClickHandler}
      >
        <button
          type="button"
          aria-label={open ? t('folders.collapse') : t('folders.expand')}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: hasChildren ? 'pointer' : 'default',
            visibility: hasChildren ? 'visible' : 'hidden',
            lineHeight: 1,
          }}
        >
          <Chevron open={open} />
        </button>

        {box && (
          <TriBox
            state={folderState}
            onToggle={toggleFolder}
            label={t('folders.selectFolderAria', { name: node.name })}
            disabled={isEmpty && !box.onToggleEmptyFolder}
            title={isEmpty && !box.onToggleEmptyFolder ? t('folders.emptyHint') : undefined}
          />
        )}

        <span aria-hidden style={{ opacity: node.synthetic ? 0.55 : 0.85 }}>
          {open ? '📂' : '📁'}
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontStyle: node.synthetic ? 'italic' : 'normal',
          }}
          title={node.path}
        >
          {node.name}
        </span>

        {nav && (
          <span style={{ display: 'flex', gap: 4, position: 'relative' }}>
            {/* A DOMAIN subfolder needs domain_admin+ (mirrors the server gate). */}
            {(scope !== 'domain' || props.canCreateDomain !== false) && (
            <button
              type="button"
              className="btn ghost sm"
              title={t('folders.newSubfolder')}
              onClick={(e) => {
                e.stopPropagation();
                nav.onCreate?.(scope, node.path);
              }}
            >
              +
            </button>
            )}
            <button
              type="button"
              className="btn ghost sm"
              title={t('folders.moveFolder')}
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((m) => !m);
              }}
            >
              •••
            </button>
            {menuOpen && (() => {
              const ref = { scope, path: node.path, id: node.id, archived: node.archived };
              // Rename / Move / Archive are offered on EVERY folder the user sees —
              // including synthetic/implicit ones (folders that exist only because items
              // were moved into a path). Those have no registry row (`id`), so the tab's
              // handler MATERIALISES a row on demand (idempotent create, then act) — never
              // a dead-end. Restore/Delete act on an already-archived ROW, which is always
              // real (archiving materialises), so they keep the `isReal` guard. One menu,
              // identical across every foldered tab.
              const isReal = node.id !== undefined && !node.synthetic;
              const close = () => setMenuOpen(false);
              const item = (label: string, onClick: () => void, danger = false) => (
                <button
                  type="button"
                  role="menuitem"
                  className="btn ghost sm"
                  style={{ width: '100%', justifyContent: 'flex-start', ...(danger ? { color: 'var(--danger)' } : {}) }}
                  onClick={(e) => { e.stopPropagation(); close(); onClick(); }}
                >
                  {label}
                </button>
              );
              return (
                <div
                  role="menu"
                  className="card"
                  style={{ position: 'absolute', top: '100%', right: 0, zIndex: 5, padding: 4, minWidth: 140 }}
                >
                  {nav.onRename && !node.archived
                    ? item(t('folders.rename'), () => {
                        const next = window.prompt(t('folders.newFolderPrompt'), node.name);
                        if (next && next.trim()) nav.onRename!(ref, next.trim());
                      })
                    : null}
                  {nav.onMove ? item(t('folders.move'), () => nav.onMove!(ref)) : null}
                  {!node.archived && nav.onArchive ? item(t('folders.archive'), () => nav.onArchive!(ref)) : null}
                  {isReal && node.archived && nav.onRestore ? item(t('folders.restore'), () => nav.onRestore!(ref)) : null}
                  {isReal && node.archived && nav.onDelete ? item(t('folders.deletePermanently'), () => nav.onDelete!(ref), true) : null}
                </div>
              );
            })()}
          </span>
        )}

        {/* Picker: "New subfolder" affordance on every row (only shown when hovered
            via CSS, but always present for keyboard access). */}
        {picker?.onCreate && (
          <button
            type="button"
            className="btn ghost sm fp-new-here"
            title={t('folders.newFolderHere')}
            disabled={creatingHere}
            onClick={handleNewFolderInPicker}
          >
            {creatingHere ? '…' : '+'}
          </button>
        )}
      </div>

      {open && (
        <div>
          {node.children.map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              depth={depth + 1}
              scope={scope}
              props={props}
              itemsByFolder={itemsByFolder}
              allItems={allItems}
              checked={checked}
              emit={emit}
              pickerSelected={pickerSelected}
              onPickerSelect={onPickerSelect}
            />
          ))}
          {/* In picker mode, leaf items are not shown — only folders are destinations. */}
          {!picker && directItems.map((item) => (
            <LeafRow
              key={item.id}
              item={item}
              depth={depth + 1}
              props={props}
              checked={checked}
              emit={emit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LeafRow({
  item,
  depth,
  props,
  checked,
  emit,
}: {
  item: FolderTreeItem;
  depth: number;
  props: FolderTreeProps;
  checked: Set<string>;
  emit: (next: Set<string>) => void;
}) {
  const t = useTranslations('common');
  const box = props.variant === 'checkbox' ? props : null;
  // Leaves are checkable unless the caller opted a kind out (Files grants by folder,
  // so its leaf ticks would be inert — render them display-only instead of dead).
  const selectable = box ? (box.leavesSelectable ?? true) : false;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 30,
        paddingLeft: 8 + depth * INDENT + 12,
        paddingRight: 8,
      }}
    >
      {box && selectable ? (
        <input
          type="checkbox"
          aria-label={t('folders.selectItemAria', { name: item.name ?? item.id })}
          checked={checked.has(item.id)}
          onChange={() => {
            const next = new Set(checked);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            emit(next);
          }}
          style={{ accentColor: 'var(--gold-deep)', cursor: 'pointer' }}
        />
      ) : box ? (
        // Keep the row aligned with checkable siblings, but show no dead control.
        <span aria-hidden style={{ display: 'inline-block', width: 13 }} />
      ) : null}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {props.renderLeaf ? props.renderLeaf(item) : (item.name ?? item.id)}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ a root --

function Root({
  scope,
  label,
  nodes,
  props,
  pickerSelected,
  onPickerSelect,
}: {
  scope: RootScope;
  label: string;
  nodes: FolderPathNode[];
  props: FolderTreeProps;
  pickerSelected?: { path: string; scope: RootScope } | null;
  onPickerSelect?: (dest: { path: string; scope: RootScope }) => void;
}) {
  const t = useTranslations('common');
  // Items belonging to THIS root. When items carry a `scope`, an item shows only under
  // its own root (no My/Shared duplication of root-level items); when none carry a
  // scope (the historical shape), every item shows under both roots as before.
  const scopedItems = useMemo(
    () => props.items.filter((i) => i.scope === undefined || i.scope === scope),
    [props.items, scope],
  );
  const rootItems = scopedItems.filter((i) => normaliseFolderPath(i.folder) === '/');
  // Folders implied by this root's items are drawn too (synthetic when they have no row), so an
  // item filed in a folder without a registry row is still reachable in the rail — but only from
  // items that provably belong to THIS root (`impliedFolderPaths`).
  const implied = useMemo(
    () => impliedFolderPaths(props.items, scope, visibleFolderRoots(props.roots)),
    [props.items, scope, props.roots],
  );
  const tree = useMemo(() => buildTree(nodes, implied), [nodes, implied]);
  const itemsByFolder = useMemo(() => {
    const m = new Map<string, FolderTreeItem[]>();
    for (const i of scopedItems) {
      const p = normaliseFolderPath(i.folder);
      const arr = m.get(p) ?? [];
      arr.push(i);
      m.set(p, arr);
    }
    return m;
  }, [scopedItems]);

  const checked = props.variant === 'checkbox' ? new Set(props.checkedIds) : new Set<string>();

  /**
   * Emit the selection for BOTH roots (they share the one `checkedIds`/`onChange`), each root
   * reduced over its own items and stamped with its own scope — see `computeFolderSelection`.
   * `rootOn` is the "All …" row of THIS root being ticked (true) or cleared (false).
   */
  function emit(nextChecked: Set<string>, rootOn?: boolean) {
    if (props.variant !== 'checkbox') return;
    const held = props.rootGrantable ? (props.rootGranted ?? []) : [];
    const rootScopes = new Set<RootScope>(held);
    if (rootOn === true && props.rootGrantable) rootScopes.add(scope);
    if (rootOn === false) rootScopes.delete(scope);
    props.onChange?.(computeFolderSelection({
      nodes: { personal: props.personalNodes, domain: props.domainNodes ?? [] },
      items: props.items,
      checked: nextChecked,
      actingScope: scope,
      rootScopes: [...rootScopes],
    }));
  }

  // A checkable "All …" root row for a kind whose root is grantable (Files): the only way to
  // grant everything in a lane, including what is filed there later. It is ticked when the lane
  // HOLDS the `/` grant — every file being ticked one by one is a dash, not a tick, because
  // that does not cover tomorrow's file. An empty lane that holds the grant still shows the row.
  const box = props.variant === 'checkbox' ? props : null;
  const rootIds = scopedItems.map((i) => i.id);
  const rootHeld = !!box?.rootGrantable && (box.rootGranted ?? []).includes(scope);
  const rootEmpty = rootIds.length === 0;
  const rootRow = box?.rootGrantable && (!rootEmpty || rootHeld) ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, paddingLeft: 8, paddingRight: 8 }}>
      <TriBox
        state={rootHeld ? 'all' : triState('/', checked, rootIds) === 'none' ? 'none' : 'some'}
        label={t('folders.grantAllAria', { label })}
        disabled={rootEmpty && !box.onToggleEmptyFolder}
        title={rootEmpty && !box.onToggleEmptyFolder ? t('folders.emptyHint') : undefined}
        onToggle={() => {
          if (rootEmpty) { box.onToggleEmptyFolder?.({ path: '/', scope }, !rootHeld); return; }
          const next = new Set(checked);
          if (rootHeld) { for (const id of rootIds) next.delete(id); emit(next, false); }
          else { for (const id of rootIds) next.add(id); emit(next, true); }
        }}
      />
      <span aria-hidden style={{ opacity: 0.85 }}>📂</span>
      <span style={{ flex: 1, fontWeight: 500 }}>{t('folders.allRoot', { label })}</span>
    </div>
  ) : null;

  const nav = props.variant === 'nav' ? props : null;
  const picker = props.variant === 'picker' ? props : null;

  // Create affordances: a DOMAIN folder needs domain_admin+ (mirrors the server
  // gate). Personal-scope creation is always offered; domain-scope creation is
  // suppressed for a viewer the caller marked as unable to create domain folders.
  const canCreateHere = scope !== 'domain' || props.canCreateDomain !== false;

  // In picker mode, root "/" is a selectable destination.
  const rootIsPickerSelected = picker !== null && pickerSelected?.path === '/' && pickerSelected?.scope === scope;

  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div
        className="section-title"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}
      >
        <span>{label}</span>
        {nav && canCreateHere && (
          <button type="button" className="btn ghost sm" onClick={() => nav.onCreate?.(scope, '/')}>
            {t('folders.newFolder')}
          </button>
        )}
        {picker?.onCreate && (
          <button
            type="button"
            className="btn ghost sm"
            title={t('folders.newFolderAtRoot')}
            onClick={async () => {
              const name = window.prompt(t('folders.newFolderPrompt'));
              if (!name?.trim()) return;
              const full = normaliseFolderPath(`/${name.trim()}`);
              await picker.onCreate!(scope, full);
              onPickerSelect?.({ path: full, scope });
            }}
          >
            {t('folders.newFolder')}
          </button>
        )}
      </div>
      {/* In picker mode, the root "/" row is a selectable destination. */}
      {picker && (
        <div
          className={`folder-row${rootIsPickerSelected ? ' is-selected' : ''}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8,
            height: 32, borderRadius: 8, cursor: 'pointer',
            background: rootIsPickerSelected ? 'var(--gold-soft)' : 'transparent',
            color: rootIsPickerSelected ? 'var(--gold-text)' : 'var(--text)',
          }}
          onClick={() => onPickerSelect?.({ path: '/', scope })}
        >
          <span aria-hidden style={{ opacity: 0.85 }}>📂</span>
          <span style={{ flex: 1 }}>{t('folders.root')}</span>
        </div>
      )}
      {rootRow}
      <div>
        {tree.map((node) => (
          <FolderRow
            key={node.path}
            node={node}
            depth={0}
            scope={scope}
            props={props}
            itemsByFolder={itemsByFolder}
            allItems={scopedItems}
            checked={checked}
            emit={emit}
            pickerSelected={pickerSelected}
            onPickerSelect={onPickerSelect}
          />
        ))}
        {!picker && rootItems.map((item) => (
          <LeafRow key={item.id} item={item} depth={0} props={props} checked={checked} emit={emit} />
        ))}
        {tree.length === 0 && (picker ? null : rootItems.length === 0) && (
          <p className="muted" style={{ paddingLeft: 8, fontSize: 13 }}>
            {t('folders.none')}
          </p>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- component --

export default function FolderTree(props: FolderTreeProps) {
  const t = useTranslations('common');
  const domainNodes = props.domainNodes ?? [];
  // Which root sections to render — defaults to BOTH (backward-compatible). A root not
  // in this list is fully hidden (no bare header), so the inactive scope's empty root
  // never shows. An active-but-empty root still renders (create-your-first-folder).
  const roots = visibleFolderRoots(props.roots);

  // Picker variant: track which (path, scope) is currently highlighted.
  const [pickerSelected, setPickerSelected] = useState<{ path: string; scope: RootScope } | null>(null);
  const picker = props.variant === 'picker' ? props : null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
      {roots.includes('personal') && (
        <Root
          scope="personal"
          label={props.personalLabel ?? t('folders.myFolders')}
          nodes={props.personalNodes}
          props={props}
          pickerSelected={pickerSelected}
          onPickerSelect={setPickerSelected}
        />
      )}
      {roots.includes('domain') && (
        <Root
          scope="domain"
          label={props.domainLabel ?? t('folders.domainFolders')}
          nodes={domainNodes}
          props={props}
          pickerSelected={pickerSelected}
          onPickerSelect={setPickerSelected}
        />
      )}
      {picker && (
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8, paddingTop: 24, alignSelf: 'stretch' }}>
          <button
            className="btn sm"
            disabled={!pickerSelected}
            onClick={() => pickerSelected && picker.onConfirm(pickerSelected)}
            style={{ minWidth: 100 }}
          >
            {t('folders.moveHere')}
          </button>
          <button className="btn ghost sm" onClick={picker.onCancel}>
            {t('actions.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------- FolderPickerModal --

/**
 * A thin modal that wraps `FolderTree` in `variant="picker"` mode.
 * Open it by rendering with `open={true}`; it dismisses on confirm or cancel.
 *
 * @param tab      — the tab namespace fed to `/api/folders` (`files`, `data`, `knowledge`).
 * @param scope    — which scope to load (`personal` only, or both roots if `'both'`).
 * @param onConfirm — receives `{ path, scope }` of the chosen destination folder.
 * @param onCancel  — called when the user dismisses without choosing.
 * @param onCreate  — async: create a new folder in `scope` at `path` (calls POST /api/folders).
 */
export function FolderPickerModal({
  open,
  tab,
  personalNodes,
  domainNodes,
  roots,
  onConfirm,
  onCancel,
  onCreate,
  title,
}: {
  open: boolean;
  tab: string;
  personalNodes: FolderPathNode[];
  domainNodes?: FolderPathNode[];
  /** Which roots the picker may offer (defaults to both). Mirrors FolderTree.roots. */
  roots?: RootScope[];
  onConfirm: (dest: { path: string; scope: RootScope }) => void;
  onCancel: () => void;
  onCreate?: (scope: RootScope, path: string) => Promise<void>;
  title?: string;
}) {
  // Escape dismisses (backdrop-click + × already do). Wired via the shared safety
  // net so the picker can never trap the user (os-ui 0.6.139). Hook runs every
  // render; it no-ops while closed.
  const t = useTranslations('common');
  useEffect(() => (open ? onEscape(onCancel) : undefined), [open, onCancel]);
  if (!open) return null;
  void tab; // consumed by the parent; kept in props for documentation clarity
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? t('folders.moveToFolder')}
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      onClick={(e) => { if (isBackdropClick(e.target, e.currentTarget)) onCancel(); }}
    >
      <div
        className="card"
        style={{
          // Clamped so a 390 px phone never scrolls sideways: never wider than the viewport
          // minus a 16 px gutter each side; 480 px minimum only where it fits.
          minWidth: 'min(480px, calc(100vw - 32px))', maxWidth: 'min(700px, calc(100vw - 32px))', width: '90vw',
          maxHeight: '75vh', overflowY: 'auto',
          padding: '20px 24px', borderRadius: 12,
          boxShadow: '0 8px 40px rgba(0,0,0,0.32)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: 0.2 }}>
            {title ?? t('folders.moveToFolder')}
          </h3>
          <button
            className="btn ghost sm"
            onClick={onCancel}
            aria-label={t('folders.close')}
            style={{ fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <FolderTree
          variant="picker"
          personalNodes={personalNodes}
          domainNodes={domainNodes ?? []}
          roots={roots}
          items={[]}
          personalLabel={t('folders.myFolders')}
          domainLabel={t('folders.domainFolders')}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onCreate={onCreate}
        />
      </div>
    </div>
  );
}
