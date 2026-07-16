/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  buildTree,
  triState,
  itemsUnderFolder,
  normaliseFolderPath,
  visibleFolderRoots,
  type FolderPathNode,
  type FolderTreeNode,
} from '@/lib/core/folders';

/**
 * FolderTree — the ONE reusable folder component every foldered tab (Files,
 * Knowledge, Data) shares. Pure UI: it holds NO tab-specific logic. Each caller
 * passes its own folder rows (`nodes`), its own already-scoped items, a
 * `renderLeaf` for a file/doc/dataset row, and the handlers it wants. The tree +
 * tri-state maths come from `lib/core/folders`.
 *
 * THREE variants, ONE component:
 *   • `variant="nav"`      — the folder rail: a breadcrumb-free hierarchy the user
 *                            navigates. Selecting a folder calls `onSelect`; an
 *                            inline "New folder" affordance calls `onCreate`; each
 *                            folder's ••• menu calls `onMove`.
 *   • `variant="checkbox"` — tri-state checkboxes on folders AND leaf items. It
 *                            emits a normalised grant `{ folderGrants, itemGrants }`
 *                            via `onChange` — a folder whose every item is checked
 *                            becomes a FOLDER grant (auto-covers future items);
 *                            a partial folder emits its checked items individually.
 *   • `variant="picker"`   — single-select destination picker. Clicking a folder
 *                            highlights it; "Move here" confirms the selection.
 *                            Inline "New folder" creates under the selected node.
 *                            Emits `{ path, scope }` via `onConfirm`; `onCancel`
 *                            dismisses without a selection. Leaf items are hidden —
 *                            only folders (and the root `/`) are selectable.
 *
 * Renders a PERSONAL root and a DOMAIN root side by side (mirrors My / Shared) so
 * the same primitive serves both scopes. Apple-clean: quiet rows, a single gold
 * accent for the active row, generous hit targets, no chrome noise.
 *
 * `FolderPickerModal` — a thin modal wrapper around `variant="picker"`. Import it
 * alongside `FolderTree` when you need the move-to-folder UX in a popover.
 */

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
}: {
  state: 'none' | 'some' | 'all';
  onToggle: () => void;
  label: string;
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
      style={{ accentColor: 'var(--gold-deep)', cursor: 'pointer' }}
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
  emit: (nextChecked: Set<string>) => void;
  pickerSelected?: { path: string; scope: RootScope } | null;
  onPickerSelect?: (dest: { path: string; scope: RootScope }) => void;
}) {
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

  function toggleFolder() {
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
    const name = window.prompt('New folder name');
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
  }, [picker, node.path, scope, onPickerSelect]);

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
          aria-label={open ? 'Collapse' : 'Expand'}
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
            state={triState(node.path, checked, underIds)}
            onToggle={toggleFolder}
            label={`Select folder ${node.name}`}
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
            <button
              type="button"
              className="btn ghost sm"
              title="New subfolder"
              onClick={(e) => {
                e.stopPropagation();
                nav.onCreate?.(scope, node.path);
              }}
            >
              +
            </button>
            <button
              type="button"
              className="btn ghost sm"
              title="Move folder"
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
                    ? item('Rename…', () => {
                        const next = window.prompt('New folder name', node.name);
                        if (next && next.trim()) nav.onRename!(ref, next.trim());
                      })
                    : null}
                  {nav.onMove ? item('Move…', () => nav.onMove!(ref)) : null}
                  {!node.archived && nav.onArchive ? item('Archive', () => nav.onArchive!(ref)) : null}
                  {isReal && node.archived && nav.onRestore ? item('Restore', () => nav.onRestore!(ref)) : null}
                  {isReal && node.archived && nav.onDelete ? item('Delete permanently', () => nav.onDelete!(ref), true) : null}
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
            title="New folder here"
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
  const box = props.variant === 'checkbox' ? props : null;
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
      {box && (
        <input
          type="checkbox"
          aria-label={`Select ${item.name ?? item.id}`}
          checked={checked.has(item.id)}
          onChange={() => {
            const next = new Set(checked);
            if (next.has(item.id)) next.delete(item.id);
            else next.add(item.id);
            emit(next);
          }}
          style={{ accentColor: 'var(--gold-deep)', cursor: 'pointer' }}
        />
      )}
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
  // Items belonging to THIS root. When items carry a `scope`, an item shows only under
  // its own root (no My/Shared duplication of root-level items); when none carry a
  // scope (the historical shape), every item shows under both roots as before.
  const scopedItems = useMemo(
    () => props.items.filter((i) => i.scope === undefined || i.scope === scope),
    [props.items, scope],
  );
  const rootItems = scopedItems.filter((i) => normaliseFolderPath(i.folder) === '/');
  const tree = useMemo(() => buildTree(nodes), [nodes]);
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

  function emit(nextChecked: Set<string>) {
    if (props.variant !== 'checkbox') return;
    // Compute the emitted selection over the FULL item list (both scopes share the one
    // `checkedIds`/`onChange`), so a toggle in this root never drops the OTHER root's
    // grants during the caller's reconcile. Only RENDERING (rootItems/itemsByFolder/
    // tri-state) is scoped, above.
    props.onChange?.(computeSelection(nodes, props.items, nextChecked, scope));
  }

  const nav = props.variant === 'nav' ? props : null;
  const picker = props.variant === 'picker' ? props : null;

  // In picker mode, root "/" is a selectable destination.
  const rootIsPickerSelected = picker !== null && pickerSelected?.path === '/' && pickerSelected?.scope === scope;

  return (
    <div style={{ flex: 1, minWidth: 220 }}>
      <div
        className="section-title"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}
      >
        <span>{label}</span>
        {nav && (
          <button type="button" className="btn ghost sm" onClick={() => nav.onCreate?.(scope, '/')}>
            New folder
          </button>
        )}
        {picker?.onCreate && (
          <button
            type="button"
            className="btn ghost sm"
            title="New folder at root"
            onClick={async () => {
              const name = window.prompt('New folder name');
              if (!name?.trim()) return;
              const full = normaliseFolderPath(`/${name.trim()}`);
              await picker.onCreate!(scope, full);
              onPickerSelect?.({ path: full, scope });
            }}
          >
            New folder
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
          <span style={{ flex: 1 }}>/ (root)</span>
        </div>
      )}
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
            No folders yet.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Reduce a raw checked-id set to the normalised grant the caller stores: a folder
 * whose EVERY under-item is checked collapses to a single FOLDER grant (so future
 * items are auto-covered); items under partially-checked folders emit
 * individually. Root-level checked items always emit individually.
 */
function computeSelection(
  nodes: FolderPathNode[],
  items: FolderTreeItem[],
  checked: Set<string>,
  scope: RootScope,
): FolderSelection {
  const folderGrants: FolderGrant[] = [];
  const covered = new Set<string>();

  // Consider every folder path that has a row OR holds items; deepest first so a
  // fully-checked deep folder is captured before its (also-full) ancestor.
  const paths = new Set<string>();
  for (const n of nodes) paths.add(normaliseFolderPath(n.path));
  for (const i of items) if (normaliseFolderPath(i.folder) !== '/') paths.add(normaliseFolderPath(i.folder));
  const ordered = [...paths].sort((a, b) => b.split('/').length - a.split('/').length);

  for (const path of ordered) {
    const under = itemsUnderFolder(path, items).map((i) => i.id);
    if (under.length === 0) continue;
    if (under.every((id) => checked.has(id))) {
      // Whole folder is checked → one folder grant; mark its items covered so we
      // don't also emit them (or a redundant ancestor grant) individually.
      if (!under.every((id) => covered.has(id))) folderGrants.push({ path, scope });
      for (const id of under) covered.add(id);
    }
  }

  const itemGrants = items
    .filter((i) => checked.has(i.id) && !covered.has(i.id))
    .map((i) => i.id);

  return { folderGrants, itemGrants };
}

// --------------------------------------------------------------- component --

export default function FolderTree(props: FolderTreeProps) {
  const domainNodes = props.domainNodes ?? [];
  // Which root sections to render — defaults to BOTH (backward-compatible). A root not
  // in this list is fully hidden (no bare header), so the inactive scope's empty root
  // never shows. An active-but-empty root still renders (create-your-first-folder).
  const roots = visibleFolderRoots(props.roots);

  // Picker variant: track which (path, scope) is currently highlighted.
  const [pickerSelected, setPickerSelected] = useState<{ path: string; scope: RootScope } | null>(null);
  const picker = props.variant === 'picker' ? props : null;

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      {roots.includes('personal') && (
        <Root
          scope="personal"
          label={props.personalLabel ?? 'My folders'}
          nodes={props.personalNodes}
          props={props}
          pickerSelected={pickerSelected}
          onPickerSelect={setPickerSelected}
        />
      )}
      {roots.includes('domain') && (
        <Root
          scope="domain"
          label={props.domainLabel ?? 'Domain folders'}
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
            Move here
          </button>
          <button className="btn ghost sm" onClick={picker.onCancel}>
            Cancel
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
  if (!open) return null;
  void tab; // consumed by the parent; kept in props for documentation clarity
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? 'Move to folder'}
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        className="card"
        style={{
          minWidth: 480, maxWidth: 700, width: '90vw',
          maxHeight: '75vh', overflowY: 'auto',
          padding: '20px 24px', borderRadius: 12,
          boxShadow: '0 8px 40px rgba(0,0,0,0.32)',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: 0.2 }}>
            {title ?? 'Move to folder'}
          </h3>
          <button
            className="btn ghost sm"
            onClick={onCancel}
            aria-label="Close"
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
          personalLabel="My folders"
          domainLabel="Domain folders"
          onConfirm={onConfirm}
          onCancel={onCancel}
          onCreate={onCreate}
        />
      </div>
    </div>
  );
}
