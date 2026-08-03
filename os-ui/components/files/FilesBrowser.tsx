/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { SCOPE_GROUPS, groupByScope, scopeCounts, rootsForScope, type ScopeKey, type FolderRoot } from '@/lib/core/scopes';
import {
  itemsUnderFolder,
  normaliseFolderPath,
  folderName,
  type FolderPathNode,
} from '@/lib/core/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@/components/core/FolderTree';
import FolderLayout from '@/components/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@/lib/folders/client';
import { useFolders } from '@/lib/folders/useFolders';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import { archiveFolderCopy, deleteFolderCopy } from '@/lib/core/lifecycle';
import { canManageArtifact, type ArtifactScope } from '@/lib/governance/edit-scope';
import { uploadRawFile, createNoteFile } from '@/lib/files/upload-client';
import FilePreview from './FilePreview';
import NoteEditor from './NoteEditor';

type Summary = {
  id: string; name: string; owner: string; domain: string;
  tier: 'dataset' | 'asset' | 'product'; kind: 'doc' | 'image' | 'video' | 'audio' | 'table' | 'archive' | 'other';
  folder: string; tags: string[]; sensitivity: string; freshness: string | null;
  version: string; status: 'processing' | 'searchable' | 'stored'; bytes: number;
  /** Original bytes render inline → the tile shows a thumbnail via /raw. */
  hasPreview?: boolean;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
};
type Facets = { folders: { path: string; count: number }[]; tags: { tag: string; count: number }[] };
type Groups = { mine: Summary[]; domain: Summary[]; marketplace: Summary[]; facets: Facets };
type Hit = { id: string; name: string; folder: string; tags: string[]; kind: Summary['kind']; score: number; snippet: string };

/** Display kind: PDFs are stored as `kind: 'doc'`, but a PDF deserves its own badge so
 *  it reads as distinct from a generic text doc. Detect by contentType if the summary
 *  ever carries it, else by a `.pdf` name suffix (the only signal the list summary has
 *  today). Everything else falls through to the stored kind. */
type BadgeKind = Summary['kind'] | 'pdf';
function badgeKind(f: Pick<Summary, 'kind' | 'name'> & { contentType?: string }): BadgeKind {
  const isPdf = f.contentType === 'application/pdf' || /\.pdf$/i.test(f.name);
  return isPdf ? 'pdf' : f.kind;
}

const KIND_LABEL: Record<BadgeKind, string> = { doc: 'DOC', pdf: 'PDF', image: 'IMG', audio: 'AUD', video: 'VID', table: 'TAB', archive: 'ZIP', other: 'FILE' };

type ViewMode = 'grid' | 'list';
type SortKey = 'name' | 'updated' | 'size' | 'type';
const VIEW_KEY = 'soa.files.view';

/** Per-file upload progress row shown while a batch is in flight / after it settles. */
type UploadItem = {
  name: string;
  /** 0–100 while uploading; final rows carry done/error. */
  pct: number;
  state: 'uploading' | 'done' | 'error';
  error?: string;
};

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

/** The visual anchor of a tile: an inline thumbnail for renderable files (image via
 *  /raw), else a big colored per-kind badge built from the existing kind-* tokens.
 *  No icon library — the OS uses text + color only. */
function FileThumb({ f }: { f: Summary }) {
  if (f.hasPreview && f.kind === 'image') {
    return (
      <div className="file-thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="file-thumb-img" src={`/api/files/${f.id}/raw`} alt="" loading="lazy" />
      </div>
    );
  }
  const bk = badgeKind(f);
  return (
    <div className={`file-thumb file-badge kind-${bk}`}>
      <span className="file-badge-label">{KIND_LABEL[bk]}</span>
    </div>
  );
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
        <StatusChip s={f.status} />
      </div>
      <FileThumb f={f} />
      <span className="file-name">{f.name}</span>
      <span className="file-sub">{f.owner} · {f.version} · {bytesLabel(f.bytes)}</span>
      {f.tags.length > 0 ? (
        <div className="file-tags">{f.tags.slice(0, 3).map((t) => <span className="chip" key={t}>{t}</span>)}</div>
      ) : null}
    </button>
  );
}

/** A dense, scannable list row — one line per file (name · type · size · status). The
 *  list view is far easier to scan for a drive with many docs/CSVs than the tile grid. */
function FileRow({
  f, on, onOpen, picked, onPick,
}: {
  f: Summary; on: boolean; onOpen: () => void;
  picked?: boolean; onPick?: (checked: boolean) => void;
}) {
  return (
    <button type="button" className={`file-row${on ? ' on' : ''}${picked ? ' picked' : ''}`} onClick={onOpen}>
      {onPick ? (
        <input
          type="checkbox" className="file-pick" aria-label={`Select ${f.name}`}
          checked={!!picked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onPick(e.target.checked)}
        />
      ) : null}
      <span className={`kind-chip kind-${badgeKind(f)}`}>{KIND_LABEL[badgeKind(f)]}</span>
      <span className="file-row-name">{f.name}</span>
      <span className="file-row-meta">{bytesLabel(f.bytes)}</span>
      <StatusChip s={f.status} />
    </button>
  );
}

/** Which folder ROOT a file's folders live in — its private tree (dataset) or the
 *  domain tree (shared/certified). Mirrors how the store groups by tier. */
function rootOf(f: Summary): FolderRoot {
  return f.tier === 'dataset' ? 'personal' : 'domain';
}

/** The edit-scope tier of a file — mirrors FilePreview so bulk actions gate exactly
 *  like the single-file detail view. */
function scopeOf(f: Summary): ArtifactScope {
  return f.tier === 'dataset' ? 'personal' : f.tier === 'product' ? 'certified' : 'shared';
}
type ManageUser = { id: string; role: Parameters<typeof canManageArtifact>[0]['role']; domains: string[] };
/** Can this user manage (archive/move) the file? Same fail-closed rule the server + the
 *  detail view use — never bulk-mutate something the user couldn't touch one-by-one. */
function canManageFile(u: ManageUser | null, f: Summary): boolean {
  return u ? canManageArtifact(u, { owner: f.owner, domain: f.domain, scope: scopeOf(f) }) : false;
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
  // Multi-select in the grid → bulk "Move to folder…" / Promote / Archive.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // A bulk op is running (disable the bar + show a spinner); a concise result notice
  // ("N requested / K failed / S skipped") shown until the next selection change.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNotice, setBulkNotice] = useState('');
  // ?archived=1 additionally returns soft-archived files (their own section), so an
  // archived file stays openable → its preview exposes Restore + Delete (OS-wide rule).
  const [showArchived, setShowArchived] = useState(false);
  // Explicit folder rows from the governed registry (Wave 1), per root. Unioned
  // with folders synthesised from the file facets so implicit folders keep showing.
  const { personalNodes, domainNodes, loadFolders } = useFolders('files', showArchived);
  // Folder picker modal: which file ids are being moved; null = closed.
  const [pickerIds, setPickerIds] = useState<string[] | null>(null);
  // Folder lifecycle: folder being moved (opens a second picker); null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);

  const confirm = useConfirm();

  // search
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);

  // view mode (grid|list) + sort. The view choice is remembered across sessions.
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'grid' || v === 'list') setViewMode(v);
    } catch { /* private mode / no storage — grid default is fine */ }
  }, []);
  const chooseView = useCallback((v: ViewMode) => {
    setViewMode(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
  }, []);

  // "＋ New" type chooser (Upload a file · New note) + the note editor overlay.
  const [newOpen, setNewOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  // upload / drag-drop
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Per-file upload progress rows + whether a batch is currently in flight.
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);

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
    // Snapshot the selection immediately (the file input resets right after) and
    // upload every file sequentially — no file is skipped.
    const batch = Array.from(files);
    if (batch.length === 0) return;
    setErr('');
    setUploading(true);
    // Seed one progress row per file up front so the whole batch is visible.
    setUploads(batch.map((f) => ({ name: f.name, pct: 0, state: 'uploading' as const })));
    const folder = sel && sel.root === 'personal' ? sel.path : '/';

    let ok = 0;
    const failures: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      const err = await uploadRawFile(batch[i], folder, (pct) =>
        setUploads((cur) => cur.map((u, idx) => (idx === i ? { ...u, pct } : u))));
      setUploads((cur) => cur.map((u, idx) =>
        idx === i ? { ...u, pct: err ? u.pct : 100, state: err ? 'error' : 'done', error: err ?? undefined } : u));
      if (err) failures.push(err); else ok += 1;
    }

    setUploading(false);
    // One clear batch summary (kept in the error strip when anything failed).
    if (failures.length > 0) {
      setErr(`${ok} uploaded, ${failures.length} failed: ${failures.join('; ')}`);
    }
    // Clear the transient progress rows shortly after a fully-clean batch; keep them
    // visible when something failed so the user can read what went wrong.
    if (failures.length === 0) setTimeout(() => setUploads([]), 1500);
    refresh();
  }, [sel, refresh]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    if (uploading) return; // a batch is in flight — ignore the drop rather than clobber it
    if (e.dataTransfer.files?.length) upload(e.dataTransfer.files);
  }, [upload, uploading]);

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

  // Bulk PROMOTE — files the user selected. Reuses the SAME per-file promote endpoint
  // the detail view uses (POST /api/files/{id}/promote), so governance is identical:
  // the server files a promotion REQUEST for each (a domain admin still approves). Only
  // personal-tier (dataset) files the user can manage are promotable; the rest are
  // reported as skipped. Result summary: "N requested / K failed / S skipped".
  const bulkPromote = useCallback(async (files: Summary[]) => {
    const mu = user ? { id: user.id, role: user.role, domains: user.domains } : null;
    const eligible = files.filter((f) => f.tier === 'dataset' && canManageFile(mu, f));
    const skipped = files.length - eligible.length;
    if (eligible.length === 0) {
      setBulkNotice(`Nothing to promote — ${skipped} not promotable.`);
      return;
    }
    setBulkBusy(true); setBulkNotice(''); setErr('');
    let requested = 0; let failed = 0;
    for (const f of eligible) {
      try {
        const res = await fetch(`/api/files/${f.id}/promote`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        if (res.ok) requested += 1; else failed += 1;
      } catch { failed += 1; }
    }
    setBulkBusy(false);
    setPicked(new Set());
    setBulkNotice(`${requested} requested${failed ? ` · ${failed} failed` : ''}${skipped ? ` · ${skipped} skipped` : ''}. A domain admin approves each.`);
    refresh();
  }, [user, refresh]);

  // Bulk ARCHIVE — reuses the SAME archive path the single-file LifecycleActions uses
  // (POST /api/files/{id} {action:'archive'}), per id. Confirmed once via the shared
  // ConfirmDialog (a multi-item lifecycle action). Only files the user can manage are
  // attempted; the rest are reported as skipped.
  const bulkArchive = useCallback(async (files: Summary[]) => {
    const mu = user ? { id: user.id, role: user.role, domains: user.domains } : null;
    const eligible = files.filter((f) => canManageFile(mu, f));
    const skipped = files.length - eligible.length;
    if (eligible.length === 0) {
      setBulkNotice(`Nothing to archive — ${skipped} not yours to manage.`);
      return;
    }
    if (!await confirm(archiveFolderCopy(`${eligible.length} file${eligible.length > 1 ? 's' : ''}`, eligible.length))) return;
    setBulkBusy(true); setBulkNotice(''); setErr('');
    let archived = 0; let failed = 0;
    for (const f of eligible) {
      try {
        const res = await fetch(`/api/files/${f.id}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'archive' }),
        });
        if (res.ok) archived += 1; else failed += 1;
      } catch { failed += 1; }
    }
    setBulkBusy(false);
    setPicked(new Set());
    setBulkNotice(`${archived} archived${failed ? ` · ${failed} failed` : ''}${skipped ? ` · ${skipped} skipped` : ''}.`);
    refresh();
  }, [user, confirm, refresh]);

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
  // Sort the visible files by the chosen key (name/updated/size/type). `updated`
  // uses freshness (newest first); the rest are stable ascending.
  const sortFiles = useCallback((rows: Summary[]): Summary[] => {
    const by = [...rows];
    by.sort((x, y) => {
      switch (sortKey) {
        case 'name': return x.name.localeCompare(y.name);
        case 'size': return y.bytes - x.bytes;
        case 'type': return x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name);
        case 'updated':
        default: return (y.freshness ?? '').localeCompare(x.freshness ?? '');
      }
    });
    return by;
  }, [sortKey]);
  const filtered = sortFiles(matched.filter((f) => !f.archived));
  const archivedFiles = sortFiles(matched.filter((f) => f.archived));
  const searching = query.trim().length > 0;

  // Bulk selection helpers: the ticked files (resolved to their Summary from the visible
  // set) and whether the whole current view is already selected (drives the Select-all
  // toggle label + its checkbox state).
  const pickedFiles = filtered.filter((f) => picked.has(f.id));
  const allInViewPicked = filtered.length > 0 && filtered.every((f) => picked.has(f.id));

  // Resolve search hits to their full Summary (from any scope) so results render with
  // the SAME tile/row as browse. Hit order (relevance) is preserved; a hit not in the
  // loaded list falls back to a minimal Summary so it still renders + opens.
  const hitFiles: Summary[] = useMemo(() => {
    if (!hits) return [];
    const all = groups ? [...groups.mine, ...groups.domain, ...groups.marketplace] : [];
    const byId = new Map(all.map((f) => [f.id, f]));
    return hits.map((h) => byId.get(h.id) ?? ({
      id: h.id, name: h.name, owner: '', domain: '', tier: 'dataset',
      kind: h.kind, folder: h.folder, tags: h.tags, sensitivity: 'internal',
      freshness: null, version: 'v1', status: 'searchable', bytes: 0,
    } as Summary));
  }, [hits, groups]);

  // One collection renderer for grid AND list, reused by the main list, the archived
  // section, and search results — so the whole tab shares one visual language.
  // `withPick` wires the multi-select checkbox (only the live main list needs it).
  const renderCollection = (rows: Summary[], withPick: boolean) => {
    const pickProps = (f: Summary) =>
      withPick
        ? {
            picked: picked.has(f.id),
            onPick: (checked: boolean) => setPicked((cur) => {
              const next = new Set(cur);
              if (checked) next.add(f.id); else next.delete(f.id);
              return next;
            }),
          }
        : {};
    if (viewMode === 'list') {
      return (
        <div className="file-list">
          {rows.map((f) => (
            <FileRow key={f.id} f={f} on={selected === f.id} onOpen={() => setSelected(f.id)} {...pickProps(f)} />
          ))}
        </div>
      );
    }
    return (
      <div className="file-grid">
        {rows.map((f) => (
          <FileCard key={f.id} f={f} on={selected === f.id} onOpen={() => setSelected(f.id)} {...pickProps(f)} />
        ))}
      </div>
    );
  };

  // ── Open file → a full-page detail that REPLACES the browser (mirrors Metrics / Data).
  // It is not an overlay: the file content IS the page and scrolls with the page. The
  // ?focus= deep-link sets `selected`, so it lands here too. "← All files" (in FilePreview)
  // clears it and returns to the drive. ──
  if (selected) {
    return (
      <FilePreview id={selected} onMutated={refresh} onClose={() => setSelected(null)} />
    );
  }

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
        {!searching ? (
          <>
            <select className="files-sort" value={sortKey} aria-label="Sort files"
              onChange={(e) => setSortKey(e.target.value as SortKey)} title="Sort files">
              <option value="updated">Updated</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="type">Type</option>
            </select>
            <div className="files-viewtoggle" role="group" aria-label="View mode">
              <button className={viewMode === 'grid' ? 'on' : ''} onClick={() => chooseView('grid')} title="Grid view" aria-pressed={viewMode === 'grid'}>Grid</button>
              <button className={viewMode === 'list' ? 'on' : ''} onClick={() => chooseView('list')} title="List view" aria-pressed={viewMode === 'list'}>List</button>
            </div>
          </>
        ) : null}
        <button
          className="btn ghost"
          style={{ opacity: 1 }}
          onClick={() => { setShowArchived((v) => !v); setSelected(null); }}
          title="Archived files are hidden by default"
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        {/* ＋ New — a TYPE chooser (OS-wide pattern): "Upload a file" (the existing
            uploader) or "New note (markdown)" (a markdown editor that saves through the
            SAME raw-upload path, so no new storage plumbing). Both land in an Edit
            surface; opening the created file lands you in View. */}
        <div className="files-new" style={{ position: 'relative' }}>
          <button className="btn" onClick={() => setNewOpen((v) => !v)} disabled={uploading}
            aria-busy={uploading} aria-haspopup="menu" aria-expanded={newOpen} {...anchorAttr(ANCHORS.files.upload)}>
            {uploading ? <><span className="spin" /> Uploading…</> : '＋ New'}
          </button>
          {newOpen ? (
            <>
              {/* Click-away backdrop closes the menu without blocking the page. */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setNewOpen(false)} aria-hidden />
              <div
                role="menu"
                className="guided-panel"
                style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 41, minWidth: 240, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <button className="btn ghost sm" role="menuitem" style={{ justifyContent: 'flex-start' }}
                  onClick={() => { setNewOpen(false); fileRef.current?.click(); }}>
                  Upload a file
                </button>
                <button className="btn ghost sm" role="menuitem" style={{ justifyContent: 'flex-start' }}
                  onClick={() => { setNewOpen(false); setNoteOpen(true); }}>
                  New note (markdown)
                </button>
              </div>
            </>
          ) : null}
        </div>
        <input ref={fileRef} type="file" multiple hidden
          onChange={(e) => { if (!uploading && e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
      </div>

      {err ? <div className="error" style={{ marginBottom: 14 }}>{err}</div> : null}

      {/* Upload progress — one calm row per file (name · % · bar), plus a batch header.
          Errors stay visible; a clean batch clears itself shortly after. */}
      {uploads.length > 0 ? (
        <div className="upload-tray">
          <div className="upload-tray-head">
            {uploading
              ? `Uploading ${uploads.length} file${uploads.length > 1 ? 's' : ''}…`
              : `${uploads.filter((u) => u.state === 'done').length} of ${uploads.length} uploaded`}
          </div>
          {uploads.map((u, i) => (
            <div key={`${u.name}-${i}`} className={`upload-row upload-${u.state}`}>
              <span className="upload-name" title={u.name}>{u.name}</span>
              <span className="upload-pct">
                {u.state === 'error' ? 'Failed' : u.state === 'done' ? 'Done ✓' : `${u.pct}%`}
              </span>
              <div className="upload-bar"><div className="upload-bar-fill" style={{ width: `${u.state === 'error' ? 100 : u.pct}%` }} /></div>
              {u.error ? <span className="upload-err">{u.error}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

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

      <FolderLayout
        allLabel="All files"
        allCount={list.length}
        allSelected={sel === null}
        onSelectAll={() => setSel(null)}
        mainClassName={`file-drop${drag ? ' drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        rail={
          <>
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
          </>
        }
      >
        {/* ---- main: search results OR the file grid ---- */}
        {searching ? (
            <>
              <div className="section-title">Results<span className="count-pill">{hits?.length ?? 0}</span></div>
              {hits && hits.length === 0 ? <div className="stub-page">No files match “{query}”.</div> : null}
              {/* Search results reuse the SAME tile/row as browse (resolved from the
                  loaded scope list by id) so the tab reads as one product. */}
              {renderCollection(hitFiles, false)}
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
                  {/* Select-all: one click ticks (or clears) every file in the current
                      view — the active scope + folder + tag filter (the `filtered` set). */}
                  <div className="files-selectall">
                    <label>
                      <input
                        type="checkbox" className="file-pick"
                        checked={allInViewPicked}
                        ref={(el) => { if (el) el.indeterminate = picked.size > 0 && !allInViewPicked; }}
                        onChange={(e) => setPicked((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) for (const f of filtered) next.add(f.id);
                          else for (const f of filtered) next.delete(f.id);
                          return next;
                        })}
                        aria-label={allInViewPicked ? 'Deselect all files' : 'Select all files'}
                      />
                      {allInViewPicked ? 'Deselect all' : 'Select all'}
                    </label>
                  </div>
                  {/* Bulk actions — appear once ≥1 card is ticked. Promote + Archive reuse
                      the same per-file governed endpoints the detail view uses. */}
                  {picked.size > 0 ? (
                    <div className="files-bulk" aria-busy={bulkBusy}>
                      <span>{picked.size} selected</span>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => promptMove([...picked])}>Move to folder…</button>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => void bulkPromote(pickedFiles)}
                        title="Propose sharing the selected files with your domain — a domain admin approves each">
                        Promote to Domain →
                      </button>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => void bulkArchive(pickedFiles)}
                        title="Archive the selected files (reversible)">
                        Archive
                      </button>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => { setPicked(new Set()); setBulkNotice(''); }}>Clear</button>
                      {bulkBusy ? <span className="file-sub"><span className="spin" /> Working…</span> : null}
                      {bulkNotice ? <span className="file-sub">{bulkNotice}</span> : null}
                    </div>
                  ) : bulkNotice ? (
                    <div className="files-bulk"><span className="file-sub">{bulkNotice}</span></div>
                  ) : null}
                  {renderCollection(filtered, true)}
                </>
              )}

              {/* Archived — openable cards; the preview exposes Restore + Delete. */}
              {showArchived && archivedFiles.length > 0 ? (
                <>
                  <div className="section-title" style={{ marginTop: 24 }}>
                    Archived<span className="count-pill">{archivedFiles.length}</span>
                  </div>
                  {renderCollection(archivedFiles, false)}
                </>
              ) : null}
            </>
          )}
      </FolderLayout>

      {/* ---- New note: the markdown Edit surface. On save it creates a text/markdown
              file through the SAME raw-upload path, then we open it in View (focus). ---- */}
      {noteOpen ? (
        <NoteEditor
          folder={sel && sel.root === 'personal' ? sel.path : '/'}
          onClose={() => setNoteOpen(false)}
          onCreated={(newId) => {
            setNoteOpen(false);
            refresh();
            setScope('all');
            setSel(null);
            setTag(null);
            setSelected(newId); // opens the new note in View (read-first)
          }}
        />
      ) : null}
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
