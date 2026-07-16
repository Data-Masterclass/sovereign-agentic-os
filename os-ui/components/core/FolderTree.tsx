/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState, type ReactNode } from 'react';
import {
  buildTree,
  triState,
  itemsUnderFolder,
  normaliseFolderPath,
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
 * TWO variants, ONE component:
 *   • `variant="nav"`      — the folder rail: a breadcrumb-free hierarchy the user
 *                            navigates. Selecting a folder calls `onSelect`; an
 *                            inline "New folder" affordance calls `onCreate`; each
 *                            folder's ••• menu calls `onMove`.
 *   • `variant="checkbox"` — tri-state checkboxes on folders AND leaf items. It
 *                            emits a normalised grant `{ folderGrants, itemGrants }`
 *                            via `onChange` — a folder whose every item is checked
 *                            becomes a FOLDER grant (auto-covers future items);
 *                            a partial folder emits its checked items individually.
 *
 * Renders a PERSONAL root and a DOMAIN root side by side (mirrors My / Shared) so
 * the same primitive serves both scopes. Apple-clean: quiet rows, a single gold
 * accent for the active row, generous hit targets, no chrome noise.
 */

export type FolderTreeItem = { id: string; folder: string; name?: string };

export type FolderGrant = { path: string; scope: 'personal' | 'domain' };
export type FolderSelection = { folderGrants: FolderGrant[]; itemGrants: string[] };

type RootScope = 'personal' | 'domain';

type CommonProps = {
  /** Folder rows for the personal root. */
  personalNodes: FolderPathNode[];
  /** Folder rows for the domain root. */
  domainNodes?: FolderPathNode[];
  /** Already-DLS-scoped items across both roots (each carries a `folder` path). */
  items: FolderTreeItem[];
  /** Render one leaf item (the tab decides the row: filename, doc title, …). */
  renderLeaf?: (item: FolderTreeItem) => ReactNode;
  /** Labels for the two roots (defaults: "My folders" / "Shared in domain"). */
  personalLabel?: string;
  domainLabel?: string;
};

type NavProps = CommonProps & {
  variant: 'nav';
  /** The currently-selected folder path (within the active root). */
  selectedPath?: string;
  onSelect?: (scope: RootScope, path: string) => void;
  /** Create a subfolder under `parentPath` in `scope`. */
  onCreate?: (scope: RootScope, parentPath: string) => void;
  /** Move `path` (its ••• menu) in `scope`. */
  onMove?: (scope: RootScope, path: string) => void;
};

type CheckboxProps = CommonProps & {
  variant: 'checkbox';
  /** Currently-checked item ids (controlled). */
  checkedIds: string[];
  onChange?: (next: FolderSelection) => void;
};

export type FolderTreeProps = NavProps | CheckboxProps;

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
}: {
  node: FolderTreeNode;
  depth: number;
  scope: RootScope;
  props: FolderTreeProps;
  itemsByFolder: Map<string, FolderTreeItem[]>;
  allItems: FolderTreeItem[];
  checked: Set<string>;
  emit: (nextChecked: Set<string>) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const [menuOpen, setMenuOpen] = useState(false);

  const directItems = itemsByFolder.get(node.path) ?? [];
  const hasChildren = node.children.length > 0 || directItems.length > 0;

  const underIds = useMemo(
    () => itemsUnderFolder(node.path, allItems).map((i) => i.id),
    [node.path, allItems],
  );

  const nav = props.variant === 'nav' ? props : null;
  const box = props.variant === 'checkbox' ? props : null;

  const isSelected =
    nav?.selectedPath !== undefined && normaliseFolderPath(nav.selectedPath) === node.path;

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

  return (
    <div>
      <div
        className={`folder-row${isSelected ? ' is-selected' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingLeft: 8 + depth * INDENT,
          paddingRight: 8,
          height: 32,
          borderRadius: 8,
          cursor: nav ? 'pointer' : 'default',
          background: isSelected ? 'var(--gold-soft)' : 'transparent',
          color: isSelected ? 'var(--gold-text)' : 'var(--text)',
        }}
        onClick={nav ? () => nav.onSelect?.(scope, node.path) : undefined}
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
            {menuOpen && (
              <div
                role="menu"
                className="card"
                style={{ position: 'absolute', top: '100%', right: 0, zIndex: 5, padding: 4, minWidth: 120 }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="btn ghost sm"
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    nav.onMove?.(scope, node.path);
                  }}
                >
                  Move…
                </button>
              </div>
            )}
          </span>
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
            />
          ))}
          {directItems.map((item) => (
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
}: {
  scope: RootScope;
  label: string;
  nodes: FolderPathNode[];
  props: FolderTreeProps;
}) {
  const rootItems = props.items.filter((i) => normaliseFolderPath(i.folder) === '/');
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const itemsByFolder = useMemo(() => {
    const m = new Map<string, FolderTreeItem[]>();
    for (const i of props.items) {
      const p = normaliseFolderPath(i.folder);
      const arr = m.get(p) ?? [];
      arr.push(i);
      m.set(p, arr);
    }
    return m;
  }, [props.items]);

  const checked = props.variant === 'checkbox' ? new Set(props.checkedIds) : new Set<string>();

  function emit(nextChecked: Set<string>) {
    if (props.variant !== 'checkbox') return;
    props.onChange?.(computeSelection(nodes, props.items, nextChecked, scope));
  }

  const nav = props.variant === 'nav' ? props : null;

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
      </div>
      <div>
        {tree.map((node) => (
          <FolderRow
            key={node.path}
            node={node}
            depth={0}
            scope={scope}
            props={props}
            itemsByFolder={itemsByFolder}
            allItems={props.items}
            checked={checked}
            emit={emit}
          />
        ))}
        {rootItems.map((item) => (
          <LeafRow key={item.id} item={item} depth={0} props={props} checked={checked} emit={emit} />
        ))}
        {tree.length === 0 && rootItems.length === 0 && (
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
  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <Root scope="personal" label={props.personalLabel ?? 'My folders'} nodes={props.personalNodes} props={props} />
      <Root scope="domain" label={props.domainLabel ?? 'Shared in domain'} nodes={domainNodes} props={props} />
    </div>
  );
}
