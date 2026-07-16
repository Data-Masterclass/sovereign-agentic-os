/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/core/scopes';
import {
  itemsUnderFolder,
  normaliseFolderPath,
  folderName,
  type FolderPathNode,
} from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import FilePreview from './FilePreview';

type Summary = {
  id: string; name: string; owner: string; domain: string;
  tier: 'dataset' | 'asset' | 'product'; kind: 'doc' | 'image' | 'video' | 'audio' | 'table' | 'archive' | 'other';
  folder: string; tags: string[]; sensitivity: string; freshness: string | null;
  version: string; status: 'processing' | 'searchable' | 'stored'; bytes: number;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
};
type Facets = { folders: { path: string; count: number }[]; tags: { tag: string; count: number }[] };
type Groups = { mine: Summary[]; domain: Summary[]; marketplace: Summary[]; facets: Facets };
type Hit = { id: string; name: string; folder: string; tags: string[]; kind: Summary['kind']; score: number; snippet: string };

const KIND_LABEL: Record<Summary['kind'], string> = { doc: 'DOC', image: 'IMG', audio: 'AUD', video: 'VID', table: 'TAB', archive: 'ZIP', other: 'FILE' };

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

function StatusChip({ s }: { s: Summary['status'] }) {
  const cls = s === 'stored' ? 's-stored' : s === 'processing' ? 's-processing' : 's-searchable';
  const label = s === 'stored' ? 'Stored' : s === 'processing' ? 'Processing…' : 'Searchable ✓';
  return <span className={`status-chip ${cls}`}>{label}</span>;
}

function FileCard({
  f, on, onOpen, picked, onPick,
}: {
  f: Summary; on: boolean; onOpen: () => void;
  picked?: boolean; onPick?: (checked: boolean) => void;
}) {
  return (
    <button type="button" className={`file-card${on ? ' on' : ''}${picked ? ' picked' : ''}`} onClick={onOpen}>
      <div className="file-card-top">
        {onPick ? (
          // Multi-select for bulk "Move to folder…". Stop the click so ticking a
          // card doesn't also open its preview.
          <input
            type="checkbox" className="file-pick" aria-label={`Select ${f.name}`}
            checked={!!picked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onPick(e.target.checked)}
          />
        ) : null}
        <span className={`kind-chip kind-${f.kind}`}>{KIND_LABEL[f.kind]}</span>
        <StatusChip s={f.status} />
      </div>
      <span className="file-name">{f.name}</span>
      <span className="file-sub">{f.owner} · {f.version} · {bytesLabel(f.bytes)}</span>
      {f.tags.length > 0 ? (
        <div className="file-tags">{f.tags.slice(0, 3).map((t) => <span className="chip" key={t}>{t}</span>)}</div>
      ) : null}
    </button>
  );
}

/** Which folder ROOT a file's folders live in — its private tree (dataset) or the
 *  domain tree (shared/certified). Mirrors how the store groups by tier. */
type FolderRoot = 'personal' | 'domain';
function rootOf(f: Summary): FolderRoot {
  return f.tier === 'dataset' ? 'personal' : 'domain';
}

/** Which folder roots to show in the rail + picker for each scope tab.
 *  - mine       → personal only (dataset-tier files)
 *  - shared     → domain only (asset/product-tier files)
 *  - marketplace → domain only (product-tier files)
 *  - all        → both (keep the current behaviour for the All view) */
function rootsForScope(scope: ScopeKey): FolderRoot[] {
  if (scope === 'mine') return ['personal'];
  if (scope === 'shared' || scope === 'marketplace') return ['domain'];
  return ['personal', 'domain'];
}

function FilesBrowserInner() {
  const { user } = useUser();
  const searchParams = useSearchParams();
  const [scope, setScope] = useState<ScopeKey>('mine');
  const [groups, setGroups] = useState<Groups | null>(null);
  const [err, setErr] = useState('');
  // The selected folder is a (root, path) pair — the FolderTree navigates both the
  // personal and the domain tree. `null` = All files (no folder filter).
  const [sel, setSel] = useState<{ root: FolderRoot; path: string } | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Explicit folder rows from the governed registry (Wave 1), per root. Unioned
  // with folders synthesised from the file facets so implicit folders keep showing.
  const [personalNodes, setPersonalNodes] = useState<FolderPathNode[]>([]);
  const [domainNodes, setDomainNodes] = useState<FolderPathNode[]>([]);
  // Multi-select in the grid → bulk "Move to folder…".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // ?archived=1 additionally returns soft-archived files (their own section), so an
  // archived file stays openable → its preview exposes Restore + Delete (OS-wide rule).
  const [showArchived, setShowArchived] = useState(false);
  // Folder picker modal: which file ids are being moved; null = closed.
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  // Folder lifecycle: folder being moved (opens a second picker); null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);

  const confirm = useConfirm();

  // search
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);

  // upload / drag-drop
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ?focus=<fileId> deep-link: once groups load, select and preview the target file.
  // We switch to 'all' scope so the item is visible regardless of which scope owns it.
  // A ref prevents the effect from re-firing on subsequent renders after the first hit.
  const focusApplied = useRef(false);
  const focusId = searchParams.get('focus') ? decodeURIComponent(searchParams.get('focus')!) : null;
  useEffect(() => {
    if (!focusId || focusApplied.current || !groups) return;
    const all = [...groups.mine, ...groups.domain, ...groups.marketplace];
    const target = all.find((f) => f.id === focusId);
    if (!target) return; // unknown id — no-op
    focusApplied.current = true;
    setScope('all');
    setSel(null);
    setTag(null);
    setSelected(focusId);
  }, [focusId, groups]);

  const loadFolders = useCallback(async () => {
    const archivedParam = showArchived ? '&archived=1' : '';
    try {
      const [pRes, dRes] = await Promise.all([
        fetch(`/api/folders?tab=files&scope=personal${archivedParam}`, { cache: 'no-store' }),
        fetch(`/api/folders?tab=files&scope=domain${archivedParam}`, { cache: 'no-store' }),
      ]);
      if (pRes.ok) setPersonalNodes(((await pRes.json()).folders ?? []) as FolderPathNode[]);
      if (dRes.ok) setDomainNodes(((await dRes.json()).folders ?? []) as FolderPathNode[]);
    } catch { /* the facet-synthesised rail still renders without the registry */ }
  }, [showArchived]);

  const refresh = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch(`/api/files${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load files'); return; }
      setGroups(data);
      void loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [showArchived, loadFolders]);
  useEffect(() => { refresh(); }, [refresh]);

  // Debounced search across the user's indexed files.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits(null); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/files/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) setHits(data.hits ?? []);
      } catch { /* ignore transient */ }
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  const upload = useCallback(async (files: FileList | File[]) => {
    setErr('');
    for (const file of Array.from(files)) {
      // Send the ORIGINAL bytes (multipart) so the file is stored and downloadable
      // byte-for-byte — the server extracts text from text-like files for search.
      const form = new FormData();
      form.append('file', file);
      form.append('name', file.name);
      // Upload into the selected folder (personal-root selections only — a new
      // upload starts private; a domain-folder selection falls back to the root).
      form.append('folder', sel && sel.root === 'personal' ? sel.path : '/');
      try {
        const res = await fetch('/api/files', { method: 'POST', body: form });
        if (!res.ok) { setErr((await res.json()).error ?? 'Upload failed'); }
      } catch (e) { setErr((e as Error).message); }
    }
    refresh();
  }, [sel, refresh]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    if (e.dataTransfer.files?.length) upload(e.dataTransfer.files);
  }, [upload]);

  // Create a folder row in the registry, then re-load the rail. New-folder + the
  // ••• "Move folder" both live on the FolderTree; move-folder reuses create-at-path.
  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const name = window.prompt('Folder name');
    if (!name || !name.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setErr('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'files', scope: root, path }),
      });
      if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [loadFolders]);

  // Move one or many files into a folder via the edit-gated folder route.
  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setErr('');
    for (const id of ids) {
      try {
        const res = await fetch(`/api/files/${id}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        if (!res.ok) { setErr((await res.json()).error ?? 'Move failed'); }
      } catch (e) { setErr((e as Error).message); }
    }
    setPicked(new Set());
    refresh();
  }, [refresh]);

  const promptMove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
  }, []);

  const uid = user?.id ?? '';
  const scoped = groups ? groupByScope(groups, uid) : null;
  const counts = groups ? scopeCounts(groups, uid) : null;
  const list = scoped ? scoped[scope] : [];
  const facets = groups?.facets ?? { folders: [], tags: [] };

  // Folder rows fed to the tree = the governed registry rows UNIONed with folders
  // synthesised from the visible files' own paths, so implicit (pre-registry)
  // folders keep showing with zero migration. Split by root (personal/domain).
  const [personalTreeNodes, domainTreeNodes] = useMemo(() => {
    const synth = (rows: FolderPathNode[], paths: string[]): FolderPathNode[] => {
      const seen = new Set(rows.map((r) => normaliseFolderPath(r.path)));
      const out = [...rows];
      for (const p of paths) {
        const n = normaliseFolderPath(p);
        if (n !== '/' && !seen.has(n)) { seen.add(n); out.push({ path: n }); }
      }
      return out;
    };
    const personalPaths = list.filter((f) => rootOf(f) === 'personal').map((f) => f.folder);
    const domainPaths = list.filter((f) => rootOf(f) === 'domain').map((f) => f.folder);
    return [synth(personalNodes, personalPaths), synth(domainNodes, domainPaths)];
  }, [personalNodes, domainNodes, list]);

  // The items the tree lays out under each root (leaves live inside their folder).
  const treeItems = useMemo(
    () => list.map((f) => ({ id: f.id, folder: f.folder, name: f.name, root: rootOf(f) })),
    [list],
  );
  const personalItems = treeItems.filter((i) => i.root === 'personal');
  const domainItems = treeItems.filter((i) => i.root === 'domain');

  // Scope-filtered nodes/items: only show the root(s) that apply to the active scope.
  // This ensures the rail and both pickers only offer folders the item can actually live in.
  const activeRoots = rootsForScope(scope);
  const visiblePersonalNodes = activeRoots.includes('personal') ? personalTreeNodes : [];
  const visibleDomainNodes = activeRoots.includes('domain') ? domainTreeNodes : [];
  const visiblePersonalItems = activeRoots.includes('personal') ? personalItems : [];
  const visibleDomainItems = activeRoots.includes('domain') ? domainItems : [];

  // Grid filter: when a folder is selected, show the files under it (incl. subfolders,
  // via itemsUnderFolder) that live in the selected root. Else the whole scope list.
  const inFolder = sel
    ? itemsUnderFolder(sel.path, list.filter((f) => rootOf(f) === sel.root))
    : list;
  const matched = inFolder.filter((f) => (!tag || f.tags.includes(tag)));
  const filtered = matched.filter((f) => !f.archived);
  const archivedFiles = matched.filter((f) => f.archived);
  const searching = query.trim().length > 0;

  return (
    <>
      <div className="files-bar">
        <div className="files-scope">
          {SCOPE_GROUPS.map((g) => (
            <button key={g.key} className={scope === g.key ? 'on' : ''}
              {...(g.key === 'mine' ? anchorAttr(ANCHORS.files.sandbox) : {})}
              onClick={() => { setScope(g.key); setSel(null); setTag(null); setSelected(null); setPicked(new Set()); }}>
              {g.label('Files')}{counts ? ` (${counts[g.key]})` : ''}
            </button>
          ))}
        </div>
        <div className="files-search" {...anchorAttr(ANCHORS.files.search)}>
          <span className="sk">Search</span>
          <input value={query} placeholder="across names, tags, and content…"
            onChange={(e) => setQuery(e.target.value)} aria-label="Search files" />
          {searching ? <button className="preview-close" onClick={() => setQuery('')} aria-label="Clear">×</button> : null}
        </div>
        <button
          className="btn ghost"
          style={{ opacity: 1 }}
          onClick={() => { setShowArchived((v) => !v); setSelected(null); }}
          title="Archived files are hidden by default"
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()} {...anchorAttr(ANCHORS.files.upload)}>Upload</button>
        <input ref={fileRef} type="file" multiple hidden
          onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
      </div>

      {err ? <div className="error" style={{ marginBottom: 14 }}>{err}</div> : null}

      <FolderPickerModal
        open={pickerIds !== null}
        tab="files"
        roots={activeRoots}
        personalNodes={visiblePersonalNodes}
        domainNodes={visibleDomainNodes}
        title={`Move ${pickerIds && pickerIds.length > 1 ? `${pickerIds.length} files` : 'file'} to folder`}
        onConfirm={({ path }) => {
          if (pickerIds) void moveInto(pickerIds, path);
          setPickerIds(null);
        }}
        onCancel={() => setPickerIds(null)}
        onCreate={async (scope, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'files', scope, path }),
          });
          if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
          await loadFolders();
        }}
      />

      {/* Folder lifecycle: move a folder to a new parent path. Only real (registry)
          folders have an id, so this modal only opens when ref.id is set. */}
      <FolderPickerModal
        open={folderMove !== null}
        tab="files"
        roots={folderMove ? [folderMove.scope] : activeRoots}
        personalNodes={folderMove?.scope === 'personal' ? visiblePersonalNodes : []}
        domainNodes={folderMove?.scope === 'domain' ? visibleDomainNodes : []}
        title="Move folder"
        onConfirm={async ({ path }) => {
          const ref = folderMove;
          setFolderMove(null);
          if (!ref) return;
          setErr('');
          try {
            // Materialise a row for a synthetic folder before reparenting it.
            const id = await ensureFolderId('files', ref);
            const res = await fetch(`/api/folders/${id}`, {
              method: 'PATCH', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path }),
            });
            if (!res.ok) { setErr((await res.json()).error ?? 'Could not move folder'); }
            else { refresh(); void loadFolders(); }
          } catch (e) { setErr((e as Error).message); }
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (scope, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'files', scope, path }),
          });
          if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
          await loadFolders();
        }}
      />

      <div className={`files-layout${selected ? ' with-preview' : ''}`}>
        {/* ---- folder rail + tag cloud (the owner's drive) ---- */}
        <nav className="files-rail files-rail-tree">
          <div>
            <button className={`rail-item${sel === null ? ' on' : ''}`} onClick={() => setSel(null)}>
              <span>All files</span><span className="rail-count">{list.length}</span>
            </button>
            {/* The reusable Wave-1 folder tree (rail variant): the governed folder
                registry UNIONed with folders synthesised from the visible files'
                paths, so implicit folders keep showing with zero migration. The two
                roots (My / Shared) stack in the narrow rail (CSS flex-wrap).
                Selecting a folder filters the grid (incl. subfolders); the ••• menu /
                New-folder edit the registry. */}
            <FolderTree
              variant="nav"
              canCreateDomain={!!user && roleAtLeast(user.role, 'domain_admin')}
              roots={activeRoots}
              personalNodes={visiblePersonalNodes}
              domainNodes={visibleDomainNodes}
              items={[...visiblePersonalItems, ...visibleDomainItems]}
              personalLabel="My folders"
              domainLabel="Domain folders"
              renderLeaf={(i) => <span className="file-sub">{i.name ?? i.id}</span>}
              selectedPath={sel?.path}
              onSelect={(root, path) =>
                setSel((cur) => (cur && cur.root === root && cur.path === path ? null : { root, path }))
              }
              onCreate={(root, parentPath) => void createFolder(root, parentPath)}
              onMove={(ref) => setFolderMove(ref)}
              onRename={(ref, newName) => {
                const path = renamedPath(ref.path, newName);
                if (!path || path === ref.path) return;
                void (async () => {
                  setErr('');
                  try {
                    // Synthetic (implicit) folders have no row → materialise, then rename.
                    const id = await ensureFolderId('files', ref);
                    const res = await fetch(`/api/folders/${id}`, {
                      method: 'PATCH', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ path }),
                    });
                    if (!res.ok) { setErr((await res.json()).error ?? 'Could not rename folder'); return; }
                    if (sel?.path === ref.path) setSel({ root: ref.scope, path });
                    refresh(); void loadFolders();
                  } catch (e) { setErr((e as Error).message); }
                })();
              }}
              onArchive={(ref) => {
                const count = itemsUnderFolder(
                  ref.path,
                  list.filter((f) => rootOf(f) === ref.scope),
                ).length;
                void (async () => {
                  if (!await confirm(archiveFolderCopy(folderName(ref.path), count))) return;
                  setErr('');
                  try {
                    // Materialise a registry row for a synthetic folder so it can be archived.
                    const id = await ensureFolderId('files', ref);
                    const res = await fetch(`/api/folders/${id}`, {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ action: 'archive' }),
                    });
                    if (!res.ok) { setErr((await res.json()).error ?? 'Could not archive folder'); return; }
                    refresh(); void loadFolders();
                  } catch (e) { setErr((e as Error).message); }
                })();
              }}
              onRestore={(ref) => {
                void (async () => {
                  setErr('');
                  try {
                    const res = await fetch(`/api/folders/${ref.id}`, {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ action: 'restore' }),
                    });
                    if (!res.ok) { setErr((await res.json()).error ?? 'Could not restore folder'); return; }
                    refresh(); void loadFolders();
                  } catch (e) { setErr((e as Error).message); }
                })();
              }}
              onDelete={(ref) => {
                const count = itemsUnderFolder(
                  ref.path,
                  list.filter((f) => rootOf(f) === ref.scope),
                ).length;
                void (async () => {
                  if (!await confirm(deleteFolderCopy(folderName(ref.path), count))) return;
                  setErr('');
                  try {
                    const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
                    if (!res.ok) { setErr((await res.json()).error ?? 'Could not delete folder'); return; }
                    if (sel?.path === ref.path) setSel(null);
                    refresh(); void loadFolders();
                  } catch (e) { setErr((e as Error).message); }
                })();
              }}
            />
          </div>
          {facets.tags.length > 0 ? (
            <div>
              <p className="rail-group-title">Tags</p>
              <div className="rail-tags">
                {facets.tags.map((t) => (
                  <button key={t.tag} className={`chip${tag === t.tag ? ' on' : ''}`} style={{ cursor: 'pointer' }}
                    onClick={() => setTag(tag === t.tag ? null : t.tag)}>{t.tag} · {t.count}</button>
                ))}
              </div>
            </div>
          ) : null}
        </nav>

        {/* ---- main: search results OR the file grid ---- */}
        <section className={`files-main file-drop${drag ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          {searching ? (
            <>
              <div className="section-title">Results<span className="count-pill">{hits?.length ?? 0}</span></div>
              {hits && hits.length === 0 ? <div className="stub-page">No files match “{query}”.</div> : null}
              <div style={{ display: 'grid', gap: 10 }}>
                {(hits ?? []).map((h) => (
                  <button key={h.id} className="result" style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
                    onClick={() => setSelected(h.id)}>
                    <div className="result-head">
                      <h4><span className={`kind-chip kind-${h.kind}`}>{KIND_LABEL[h.kind]}</span> {h.name}</h4>
                      <span className="score">{h.folder}</span>
                    </div>
                    {h.snippet ? <p className="result-text">{h.snippet}</p> : null}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {groups === null ? (
                <div className="stub-page"><span className="spin" /> Loading your drive…</div>
              ) : filtered.length === 0 ? (
                <div className="stub-page">
                  {scope === 'mine' || scope === 'all'
                    ? 'No files here yet. Drag a file in, or use Upload — any type works.'
                    : `Nothing in ${scope === 'shared' ? 'Domain' : 'Company'} yet.`}
                </div>
              ) : (
                <>
                  {/* Bulk actions — appear once ≥1 card is ticked. */}
                  {picked.size > 0 ? (
                    <div className="files-bulk">
                      <span>{picked.size} selected</span>
                      <button className="btn ghost sm" onClick={() => promptMove([...picked])}>Move to folder…</button>
                      <button className="btn ghost sm" onClick={() => setPicked(new Set())}>Clear</button>
                    </div>
                  ) : null}
                  <div className="file-grid">
                    {filtered.map((f) => (
                      <FileCard
                        key={f.id} f={f} on={selected === f.id} onOpen={() => setSelected(f.id)}
                        picked={picked.has(f.id)}
                        onPick={(checked) => setPicked((cur) => {
                          const next = new Set(cur);
                          if (checked) next.add(f.id); else next.delete(f.id);
                          return next;
                        })}
                      />
                    ))}
                  </div>
                </>
              )}

              {/* Archived — openable cards; the preview exposes Restore + Delete. */}
              {showArchived && archivedFiles.length > 0 ? (
                <>
                  <div className="section-title" style={{ marginTop: 24 }}>
                    Archived<span className="count-pill">{archivedFiles.length}</span>
                  </div>
                  <div className="file-grid">
                    {archivedFiles.map((f) => (
                      <FileCard key={f.id} f={f} on={selected === f.id} onOpen={() => setSelected(f.id)} />
                    ))}
                  </div>
                </>
              ) : null}
            </>
          )}
        </section>

        {/* ---- preview pane ---- */}
        {selected ? (
          <FilePreview id={selected} onMutated={refresh} onClose={() => setSelected(null)} />
        ) : null}
      </div>
    </>
  );
}

export default function FilesBrowser() {
  return (
    <Suspense>
      <ConfirmProvider>
        <FilesBrowserInner />
      </ConfirmProvider>
    </Suspense>
  );
}
