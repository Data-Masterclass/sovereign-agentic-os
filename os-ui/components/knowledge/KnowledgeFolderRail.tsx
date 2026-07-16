/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import FolderTree, { FolderPickerModal, type FolderRef, type FolderTreeItem } from '@/components/core/FolderTree';
import { useConfirm } from '@/components/lifecycle/ConfirmDialog';
import {
  itemsUnderFolder,
  folderName,
  type FolderPathNode,
} from '@/lib/core/folders';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';

/**
 * The "My knowledge" folder rail — the shared `FolderTree` (nav variant) wired to the
 * ONE folder lifecycle (create / move / archive / restore / delete) exactly like Files,
 * Data and Metrics. Knowledge only folders its PERSONAL lane (My knowledge), so this rail
 * shows the single personal root — already the scope-driven single-root shape.
 *
 * Extracted into its own component so it can call `useConfirm()` from inside the page's
 * <ConfirmProvider> (the folder archive/delete confirms share the OS-wide copy).
 */
export default function KnowledgeFolderRail({
  nodes,
  items,
  selectedPath,
  onSelect,
  onChanged,
}: {
  /** Personal folder registry rows (incl. archived when the page requests them). */
  nodes: FolderPathNode[];
  /** The personal-lane entries laid out under the tree. */
  items: FolderTreeItem[];
  selectedPath: string;
  onSelect: (path: string) => void;
  /** Re-load folders + entries after a mutation. */
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const [err, setErr] = useState('');
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);

  async function createFolder(parentPath: string) {
    const name = window.prompt('Folder name');
    if (!name?.trim()) return;
    const full = parentPath === '/' ? `/${name.trim()}` : `${parentPath}/${name.trim()}`;
    setErr('');
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 'knowledge', scope: 'personal', path: full }),
    });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Could not create folder'); return; }
    onChanged();
  }

  async function moveFolder(ref: FolderRef, dest: string) {
    setErr('');
    const res = await fetch(`/api/folders/${ref.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dest }),
    });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Move failed'); return; }
    onChanged();
  }

  /** Count of entries under a folder (incl. subfolders) — drives the cascade warning. */
  function countUnder(path: string): number {
    return itemsUnderFolder(path, items).length;
  }

  async function archiveFolder(ref: FolderRef) {
    if (!(await confirm(archiveFolderCopy(folderName(ref.path), countUnder(ref.path))))) return;
    setErr('');
    const res = await fetch(`/api/folders/${ref.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'archive' }),
    });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Archive failed'); return; }
    onChanged();
  }

  async function restoreFolder(ref: FolderRef) {
    setErr('');
    const res = await fetch(`/api/folders/${ref.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restore' }),
    });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Restore failed'); return; }
    onChanged();
  }

  async function deleteFolder(ref: FolderRef) {
    if (!(await confirm(deleteFolderCopy(folderName(ref.path), countUnder(ref.path))))) return;
    setErr('');
    const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Delete failed'); return; }
    onChanged();
  }

  return (
    <>
      {err ? <div className="error" style={{ marginTop: 8 }}>{err}</div> : null}
      <FolderTree
        variant="nav"
        personalNodes={nodes}
        items={items}
        selectedPath={selectedPath}
        personalLabel="My folders"
        onSelect={(_scope, path) => onSelect(path)}
        onCreate={(_scope, parentPath) => void createFolder(parentPath)}
        onMove={(ref) => { if (ref.id) setFolderMove(ref); }}
        onArchive={(ref) => void archiveFolder(ref)}
        onRestore={(ref) => void restoreFolder(ref)}
        onDelete={(ref) => void deleteFolder(ref)}
      />
      <FolderPickerModal
        open={folderMove !== null}
        tab="knowledge"
        personalNodes={nodes}
        title="Move folder"
        onConfirm={({ path }) => {
          const ref = folderMove;
          setFolderMove(null);
          if (ref?.id) void moveFolder(ref, path);
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (_scope, path) => {
          await fetch('/api/folders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'knowledge', scope: 'personal', path }),
          });
          onChanged();
        }}
      />
    </>
  );
}
