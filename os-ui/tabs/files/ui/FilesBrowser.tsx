/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useUser } from '@core/ui/useUser';
import DomainTag from '@core/ui/DomainTag';
import { roleAtLeast } from '@core/kernel/session';
import { SCOPE_GROUPS, groupByScope, scopeCounts, rootsForScope, type ScopeKey, type FolderRoot } from '@core/kernel/scopes';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';
import {
  itemsUnderFolder,
  normaliseFolderPath,
  folderName,
  type FolderPathNode,
} from '@core/kernel/folders';
import FolderTree, { FolderPickerModal, type FolderRef } from '@core/ui/core/FolderTree';
import FolderLayout from '@core/ui/core/FolderLayout';
import { ensureFolderId, renamedPath } from '@core/folders/client';
import { useFolders } from '@core/folders/useFolders';
import { ConfirmProvider, useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import type { ConfirmCopy } from '@core/kernel/lifecycle';
import { canManageArtifact, type ArtifactScope } from '@core/policy/edit-scope';
import { uploadRawFile, uploadErrorMessage } from '@tabs/files/lib/upload-client';
import { serverError, summariseBulk, type BulkOutcome, type BulkSummary } from '@tabs/files/lib/bulk-result';
import { describeAndTagPatch, parseTagInput, type DescribeAndTagInput } from '@tabs/files/lib/bulk-docs';
import { promotionReadiness, type Readiness } from '@tabs/files/lib/promotion';
import FilePreview from '@tabs/files/ui/FilePreview';
import NoteEditor from '@tabs/files/ui/NoteEditor';
import { FILE_STATUS_KEY, fileStatusClass, type FileStatus } from '@tabs/files/lib/file-status';

type Summary = {
  id: string; name: string; owner: string; domain: string;
  tier: 'dataset' | 'asset' | 'product'; kind: 'doc' | 'image' | 'video' | 'audio' | 'table' | 'archive' | 'other';
  folder: string; tags: string[];
  /** The promotion-gate documentation, carried by the listing so the toolbar can pre-flight
   *  the gate with the SAME `promotionGate` the server runs. */
  description: string;
  sensitivity: string; freshness: string | null;
  version: string; status: FileStatus; bytes: number;
  /** Original bytes render inline → the tile shows a thumbnail via /raw. */
  hasPreview?: boolean;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
  /** Description / tags written automatically and not edited since. */
  suggested?: { description: boolean; tags: string[] };
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

type FilesT = ReturnType<typeof useTranslations<'files'>>;

/** The past participle a bulk notice is worded around — each has its own message. */
type BulkVerb = 'moved' | 'requested' | 'updated' | 'archived';

/** A promotion-gate gap (`promotionGate`'s English token) in the user's language; unknown tokens as they are. */
function gapLabel(token: string, t: FilesT): string {
  switch (token) {
    case 'owner': return t('gap.owner');
    case 'domain': return t('gap.domain');
    case 'a description': return t('gap.description');
    case 'at least one tag': return t('gap.tag');
    default: return token;
  }
}

/** "Add a description, at least one tag first — …" for a disabled Promote; '' when nothing blocks. */
function readinessHintOf(r: Pick<Readiness, 'blocked'>, t: FilesT): string {
  const gaps = [...new Set(r.blocked.flatMap((b) => b.missing))];
  return gaps.length ? t('bulk.readinessHint', { gaps: gaps.map((g) => gapLabel(g, t)).join(', ') }) : '';
}

/** "2 personal · 1 domain" — which tiers a selection spans; '' for none. */
function breakdownOf(rows: { tier: 'dataset' | 'asset' | 'product' }[], t: FilesT): string {
  const count = (tier: string) => rows.filter((r) => r.tier === tier).length;
  const parts: string[] = [];
  if (count('dataset')) parts.push(t('describe.breakdownPersonal', { count: count('dataset') }));
  if (count('asset')) parts.push(t('describe.breakdownDomain', { count: count('asset') }));
  if (count('product')) parts.push(t('describe.breakdownCompany', { count: count('product') }));
  return parts.join(' · ');
}

/** The bulk toolbar notice, worded from `summariseBulk`'s counts (its English `notice` is for non-UI readers). */
function bulkNoticeOf(sum: BulkSummary, verb: BulkVerb, t: FilesT, withApprovalNote = false): string {
  const items: string[] = [];
  if (sum.requested) items.push(t(`notice.${verb}`, { count: sum.requested }));
  if (sum.promoted) items.push(t('notice.promoted', { count: sum.promoted }));
  if (items.length === 0) items.push(t(`notice.nothing.${verb}`));
  if (sum.already) items.push(t('notice.already', { count: sum.already }));
  if (sum.failed) items.push(t('notice.failed', { count: sum.failed }));
  if (sum.skipped) items.push(t('notice.skipped', { count: sum.skipped }));
  const sentences = [t('notice.line', { items: items.join(' · ') })];
  if (sum.requested > 0 && withApprovalNote) sentences.push(t('notice.approvalNote'));
  for (const g of sum.reasons) {
    sentences.push(g.count === 1 && g.names[0]
      ? t('notice.reasonOne', { name: g.names[0], reason: g.reason })
      : t('notice.reasonMany', { count: g.count, reason: g.reason }));
  }
  return sentences.join(' ');
}

/** The shared folder-archive confirm, in the user's language (same words as the core copy in English). */
function archiveCopy(name: string, count: number, t: FilesT): ConfirmCopy {
  return { title: t('confirm.archiveTitle', { name }), body: t('confirm.archiveBody', { name, count }), confirmLabel: t('confirm.archiveConfirm'), danger: false };
}
/** The shared folder physical-delete confirm — permanent, cascades to the items inside. */
function deleteCopy(name: string, count: number, t: FilesT): ConfirmCopy {
  return { title: t('confirm.deleteTitle', { name }), body: t('confirm.deleteBody', { name, count }), confirmLabel: t('confirm.deleteConfirm'), danger: true };
}

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

function StatusChip({ s }: { s: Summary['status'] }) {
  const t = useTranslations('files');
  return <span className={`status-chip ${fileStatusClass(s)}`}>{t(`status.${FILE_STATUS_KEY[s]}`)}</span>;
}

/** The visual anchor of a tile: an inline thumbnail for renderable files (image via
 *  /raw), else a big colored per-kind badge built from the existing kind-* tokens.
 *  No icon library — the OS uses text + color only. */
function FileThumb({ f }: { f: Summary }) {
  const t = useTranslations('files');
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
      <span className="file-badge-label">{t(`kind.${bk}`)}</span>
    </div>
  );
}

function FileCard({
  f, on, onOpen, picked, onPick,
}: {
  f: Summary; on: boolean; onOpen: () => void;
  picked?: boolean; onPick?: (checked: boolean) => void;
}) {
  const t = useTranslations('files');
  const f8 = useFormat();
  return (
    <button type="button" className={`file-card${on ? ' on' : ''}${picked ? ' picked' : ''}`} onClick={onOpen}>
      <div className="file-card-top">
        {onPick ? (
          // Multi-select for bulk "Move to folder…". Stop the click so ticking a
          // card doesn't also open its preview.
          <input
            type="checkbox" className="file-pick" aria-label={t('browser.selectFile', { name: f.name })}
            checked={!!picked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onPick(e.target.checked)}
          />
        ) : null}
        <StatusChip s={f.status} />
      </div>
      <FileThumb f={f} />
      <span className="file-name">{f.name}</span>
      <span className="file-sub">{f.owner} · {f.version} · {f8.bytes(f.bytes)}</span>
      {f.tags.length > 0 ? (
        <div className="file-tags">
          {f.tags.slice(0, 3).map((tag) => <span className="chip" key={tag}>{tag}</span>)}
          {f.tags.slice(0, 3).some((tag) => f.suggested?.tags.includes(tag)) ? <span className="suggested-mark" title={t('suggested.tooltip')}>{t('suggested.word')}</span> : null}
        </div>
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
  const t = useTranslations('files');
  const f8 = useFormat();
  return (
    <button type="button" className={`file-row${on ? ' on' : ''}${picked ? ' picked' : ''}`} onClick={onOpen}>
      {onPick ? (
        <input
          type="checkbox" className="file-pick" aria-label={t('browser.selectFile', { name: f.name })}
          checked={!!picked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onPick(e.target.checked)}
        />
      ) : null}
      <span className={`kind-chip kind-${badgeKind(f)}`}>{t(`kind.${badgeKind(f)}`)}</span>
      <span className="file-row-name">{f.name}</span>
      {/* Company files are visible in every domain — badge them and name their home domain. */}
      {f.tier === 'product' ? <span className="badge vis-certified">{t('browser.companyBadge')}</span> : null}
      {f.tier === 'product' ? <DomainTag domain={f.domain} /> : null}
      <span className="file-row-meta">{f8.bytes(f.bytes)}</span>
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


/**
 * "Describe & tag" over a selection — the documentation the promotion gate asks for, written
 * once for many files. The SEMANTICS live in `@tabs/files/lib/bulk-docs` (append vs replace,
 * fill vs overwrite) so they are unit-tested; this is only the form.
 *
 * Both defaults are the non-destructive ones: tags are appended and a description is written
 * only where one is missing. Replacing or overwriting is an explicit tick, because a bulk
 * action that silently dropped an author's own words would destroy work on a mis-click.
 */
function DescribeAndTagModal({ rows, busy, onCancel, onApply }: {
  /** The files this will touch — already filtered to what the user may manage. */
  rows: Summary[];
  busy: boolean;
  onCancel: () => void;
  onApply: (input: DescribeAndTagInput) => void;
}) {
  const t = useTranslations('files');
  const tc = useTranslations('common');
  const count = rows.length;
  // A domain admin's selection can span tiers, and this relabels SHARED assets too — say so
  // before Apply, not after (review L1).
  const breakdown = breakdownOf(rows, t);
  const [description, setDescription] = useState('');
  const [tagText, setTagText] = useState('');
  const [overwriteDescription, setOverwriteDescription] = useState(false);
  const [replaceTags, setReplaceTags] = useState(false);
  const tags = parseTagInput(tagText);
  // Nothing to apply: no description, no tags, and not an explicit clear.
  const empty = !description.trim() && tags.length === 0 && !replaceTags;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('describe.aria')}
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
          minWidth: 420, maxWidth: 620, width: '90vw', maxHeight: '75vh', overflowY: 'auto',
          padding: '20px 24px', borderRadius: 12, boxShadow: '0 8px 40px rgba(0,0,0,0.32)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: 0.2 }}>
            {t('describe.title', { count })}
            {breakdown ? <span className="file-sub" style={{ marginLeft: 8, fontWeight: 400 }}>{breakdown}</span> : null}
          </h3>
          <button className="btn ghost sm" onClick={onCancel} aria-label={t('describe.close')} style={{ fontSize: 18, lineHeight: 1 }}>
            ×
          </button>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          {t.rich('describe.intro', { strong: (c) => <strong>{c}</strong> })}
        </p>
        <label className="rail-group-title" htmlFor="bulk-docs-description">{t('describe.description')}</label>
        <textarea
          id="bulk-docs-description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('describe.descriptionPlaceholder')}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={overwriteDescription}
            onChange={(e) => setOverwriteDescription(e.target.checked)} />
          {t('describe.overwrite')}
        </label>
        <label className="rail-group-title" htmlFor="bulk-docs-tags">{t('describe.tags')}</label>
        <input
          id="bulk-docs-tags"
          value={tagText}
          onChange={(e) => setTagText(e.target.value)}
          placeholder={t('describe.tagsPlaceholder')}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={replaceTags} onChange={(e) => setReplaceTags(e.target.checked)} />
          {t('describe.replace')}
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost sm" onClick={onCancel}>{tc('actions.cancel')}</button>
          <button
            className="btn sm"
            disabled={busy || empty}
            title={empty ? t('describe.emptyTitle') : t('describe.apply', { count })}
            onClick={() => onApply({ description, tags, overwriteDescription, replaceTags })}
          >
            {t('describe.apply', { count })}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilesBrowserInner() {
  const t = useTranslations('files');
  const msg = useServerMessage();
  const f8 = useFormat();
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
  // "Describe & tag" dialog over the current selection (false = closed).
  const [docsOpen, setDocsOpen] = useState(false);
  // Folder lifecycle: folder being moved (opens a second picker); null = closed.
  const [folderMove, setFolderMove] = useState<FolderRef | null>(null);

  const confirm = useConfirm();

  // search
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  // Set when search fell back (index or embedding gateway unavailable) — said, never hidden.
  const [searchNote, setSearchNote] = useState('');

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
      if (!res.ok) { setErr(msg(data, t('errors.loadFiles'))); return; }
      setGroups(data);
      void loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [showArchived, loadFolders, t]);
  useEffect(() => { refresh(); }, [refresh]);

  // Debounced search across the user's indexed files.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits(null); setSearchNote(''); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/files/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) { setHits(data.hits ?? []); setSearchNote(typeof data.note === 'string' ? data.note : ''); }
      } catch { /* ignore transient */ }
    }, 220);
    return () => clearTimeout(timer);
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
      const failure = await uploadRawFile(batch[i], folder, (pct) =>
        setUploads((cur) => cur.map((u, idx) => (idx === i ? { ...u, pct } : u))));
      const err = failure ? uploadErrorMessage(failure, t, msg) : null;
      setUploads((cur) => cur.map((u, idx) =>
        idx === i ? { ...u, pct: err ? u.pct : 100, state: err ? 'error' : 'done', error: err ?? undefined } : u));
      if (err) failures.push(err); else ok += 1;
    }

    setUploading(false);
    // One clear batch summary (kept in the error strip when anything failed).
    if (failures.length > 0) {
      setErr(t('upload.batchFailed', { ok, failed: failures.length, reasons: failures.join('; ') }));
    }
    // Clear the transient progress rows shortly after a fully-clean batch; keep them
    // visible when something failed so the user can read what went wrong.
    if (failures.length === 0) setTimeout(() => setUploads([]), 1500);
    refresh();
  }, [sel, refresh, t]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    if (uploading) return; // a batch is in flight — ignore the drop rather than clobber it
    if (e.dataTransfer.files?.length) upload(e.dataTransfer.files);
  }, [upload, uploading]);

  // Create a folder row in the registry, then re-load the rail. New-folder + the
  // ••• "Move folder" both live on the FolderTree; move-folder reuses create-at-path.
  const createFolder = useCallback(async (root: FolderRoot, parentPath: string) => {
    const name = window.prompt(t('browser.folderPrompt'));
    if (!name || !name.trim()) return;
    const path = normaliseFolderPath(`${parentPath === '/' ? '' : parentPath}/${name.trim()}`);
    setErr('');
    try {
      const res = await fetch('/api/folders', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tab: 'files', scope: root, path }),
      });
      if (!res.ok) { setErr(msg(await res.json(), t('errors.createFolder'))); return; }
      await loadFolders();
    } catch (e) { setErr((e as Error).message); }
  }, [loadFolders, t]);

  // Move one or many files into a folder via the edit-gated folder route.
  //
  // PER-FILE RESULTS (review M2). This loop wrote every failure into the ONE error strip, so
  // moving twelve files and being refused on eleven showed the twelfth's reason and lost the
  // rest — "the last writer wins" is the same defect as counting `res.ok`. Each file is now an
  // outcome carrying the server's own text, reported by the shared formatter.
  const moveInto = useCallback(async (ids: string[], folder: string) => {
    setErr('');
    const all = groups ? [...groups.mine, ...groups.domain, ...groups.marketplace] : [];
    const nameOf = (id: string) => all.find((f) => f.id === id)?.name ?? id;
    setBulkBusy(true); setBulkNotice('');
    const outcomes: BulkOutcome[] = [];
    for (const id of ids) {
      try {
        const res = await fetch(`/api/files/${id}/folder`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ folder }),
        });
        const data = await res.json().catch(() => ({}));
        outcomes.push(res.ok
          ? { id, name: nameOf(id), ok: true }
          : { id, name: nameOf(id), ok: false, error: serverError(data, t('errors.moveFailed')) });
      } catch (e) {
        outcomes.push({ id, name: nameOf(id), ok: false, error: (e as Error).message });
      }
    }
    setBulkBusy(false);
    setPicked(new Set());
    setBulkNotice(bulkNoticeOf(summariseBulk(outcomes, { verb: 'moved' }), 'moved', t));
    refresh();
  }, [refresh, groups, t]);

  const promptMove = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setPickerIds(ids);
  }, []);

  // Bulk PROMOTE — files the user selected. Reuses the SAME per-file promote endpoint
  // the detail view uses (POST /api/files/{id}/promote), so governance is identical:
  // the server files a promotion REQUEST for each (a domain admin still approves). Only
  // personal-tier (dataset) files the user can manage are promotable; the rest are
  // reported as skipped.
  //
  // PER-FILE RESULTS (2026-11-18). This loop used to count `res.ok` and throw the response
  // body away, so twelve files refused by the documentation gate read as
  // "0 requested · 1 failed. A domain admin approves each." — no reason, and a promise of an
  // approval that was never filed. Every outcome now carries the server's own `error` text
  // (`serverError`) and `summariseBulk` collapses identical reasons into one line and drops
  // the approval sentence when nothing was requested.
  const bulkPromote = useCallback(async (files: Summary[]) => {
    const mu = user ? { id: user.id, role: user.role, domains: user.domains } : null;
    const eligible = files.filter((f) => f.tier === 'dataset' && canManageFile(mu, f));
    const skipped = files.length - eligible.length;
    if (eligible.length === 0) {
      setBulkNotice(bulkNoticeOf(summariseBulk([], { verb: 'requested', skipped }), 'requested', t));
      return;
    }
    setBulkBusy(true); setBulkNotice(''); setErr('');
    const outcomes: BulkOutcome[] = [];
    for (const f of eligible) {
      try {
        const res = await fetch(`/api/files/${f.id}/promote`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        // The route answers with exactly one of three shapes, and each reads differently:
        //   { promoted: true, requested: false } — the owner-approver's ONE SHOT: already in
        //       the domain, so it is not a request and nobody has to approve it (PR #61);
        //   { requested: true, already: true }   — a request was ALREADY open; this press
        //       filed nothing (review M1);
        //   { requested: true, promoted: false } — a request was filed.
        // `promoted` is tested first because it carries `requested: false`.
        outcomes.push(res.ok
          ? { id: f.id, name: f.name, ok: true, promoted: data.promoted === true, already: data.already === true }
          : { id: f.id, name: f.name, ok: false, error: serverError(data, t('errors.promoteFailed')) });
      } catch (e) {
        outcomes.push({ id: f.id, name: f.name, ok: false, error: (e as Error).message });
      }
    }
    setBulkBusy(false);
    setPicked(new Set());
    setBulkNotice(bulkNoticeOf(summariseBulk(outcomes, {
      verb: 'requested', skipped, approvalNote: 'A domain admin approves each.',
    }), 'requested', t, true));
    refresh();
  }, [user, refresh, t]);

  // Bulk DESCRIBE & TAG — the fix for the gate that refuses an undocumented file, offered in
  // the toolbar that reported the refusal. One description + one tag list over the selection,
  // through the EXISTING per-file write path (PATCH /api/files/{id} → setDocs, edit-gated),
  // so there is no second gate. Tags are appended (set-union) and a description fills a gap;
  // replacing or overwriting is an explicit tick. `describeAndTagPatch` returning null means
  // the file would not change — skipped, never "failed", and no version churn.
  const bulkDescribeAndTag = useCallback(async (files: Summary[], input: DescribeAndTagInput) => {
    const mu = user ? { id: user.id, role: user.role, domains: user.domains } : null;
    const eligible = files.filter((f) => canManageFile(mu, f));
    let skipped = files.length - eligible.length;
    const work: { file: Summary; patch: Record<string, unknown> }[] = [];
    for (const f of eligible) {
      const patch = describeAndTagPatch({ id: f.id, name: f.name, description: f.description, tags: f.tags }, input);
      if (patch) work.push({ file: f, patch });
      else skipped += 1; // already carries exactly this documentation
    }
    if (work.length === 0) {
      setBulkNotice(bulkNoticeOf(summariseBulk([], { verb: 'updated', skipped }), 'updated', t));
      return;
    }
    setBulkBusy(true); setBulkNotice(''); setErr('');
    const outcomes: BulkOutcome[] = [];
    for (const { file, patch } of work) {
      try {
        const res = await fetch(`/api/files/${file.id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
        });
        const data = await res.json().catch(() => ({}));
        outcomes.push(res.ok
          ? { id: file.id, name: file.name, ok: true }
          : { id: file.id, name: file.name, ok: false, error: serverError(data, t('errors.updateFailed')) });
      } catch (e) {
        outcomes.push({ id: file.id, name: file.name, ok: false, error: (e as Error).message });
      }
    }
    setBulkBusy(false);
    setBulkNotice(bulkNoticeOf(summariseBulk(outcomes, { verb: 'updated', skipped }), 'updated', t));
    refresh();
  }, [user, refresh, t]);

  // Bulk ARCHIVE — reuses the SAME archive path the single-file LifecycleActions uses
  // (POST /api/files/{id} {action:'archive'}), per id. Confirmed once via the shared
  // ConfirmDialog (a multi-item lifecycle action). Only files the user can manage are
  // attempted; the rest are reported as skipped — and each refusal keeps the server's own
  // reason, through the same formatter Promote uses (review M2).
  const bulkArchive = useCallback(async (files: Summary[]) => {
    const mu = user ? { id: user.id, role: user.role, domains: user.domains } : null;
    const eligible = files.filter((f) => canManageFile(mu, f));
    const skipped = files.length - eligible.length;
    if (eligible.length === 0) {
      setBulkNotice(bulkNoticeOf(summariseBulk([], { verb: 'archived', skipped }), 'archived', t));
      return;
    }
    if (!await confirm(archiveCopy(t('confirm.selectionName', { count: eligible.length }), eligible.length, t))) return;
    setBulkBusy(true); setBulkNotice(''); setErr('');
    const outcomes: BulkOutcome[] = [];
    for (const f of eligible) {
      try {
        const res = await fetch(`/api/files/${f.id}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'archive' }),
        });
        const data = await res.json().catch(() => ({}));
        outcomes.push(res.ok
          ? { id: f.id, name: f.name, ok: true }
          : { id: f.id, name: f.name, ok: false, error: serverError(data, t('errors.archiveFailed')) });
      } catch (e) {
        outcomes.push({ id: f.id, name: f.name, ok: false, error: (e as Error).message });
      }
    }
    setBulkBusy(false);
    setPicked(new Set());
    setBulkNotice(bulkNoticeOf(summariseBulk(outcomes, { verb: 'archived', skipped }), 'archived', t));
    refresh();
  }, [user, confirm, refresh, t]);

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

  // PRE-FLIGHT the promotion gate on the LISTING rows, before anything is POSTed — the
  // toolbar says "3 of 12 ready to promote" and names the gap, instead of letting the user
  // discover it twelve 400s later. `promotionReadiness` runs the SAME `promotionGate` the
  // store and Governance run; the summary carries `description` precisely so it can.
  const manageUser = user ? { id: user.id, role: user.role, domains: user.domains } : null;
  const manageable = pickedFiles.filter((f) => canManageFile(manageUser, f));
  const promotable = manageable.filter((f) => f.tier === 'dataset');
  const readiness = promotionReadiness(promotable);

  // Resolve search hits to their full Summary (from any scope) so results render with
  // the SAME tile/row as browse. Hit order (relevance) is preserved; a hit not in the
  // loaded list falls back to a minimal Summary so it still renders + opens.
  const hitFiles: Summary[] = useMemo(() => {
    if (!hits) return [];
    const all = groups ? [...groups.mine, ...groups.domain, ...groups.marketplace] : [];
    const byId = new Map(all.map((f) => [f.id, f]));
    return hits.map((h) => byId.get(h.id) ?? ({
      id: h.id, name: h.name, owner: '', domain: '', tier: 'dataset',
      kind: h.kind, folder: h.folder, tags: h.tags, description: '', sensitivity: 'internal',
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
              onClick={() => { setScope(g.key); setSel(null); setTag(null); setSelected(null); setPicked(new Set()); }}>
              {counts ? t(`scope.${g.key}Count`, { count: counts[g.key] }) : t(`scope.${g.key}`)}
            </button>
          ))}
        </div>
        <div className="files-search">
          <span className="sk">{t('browser.search')}</span>
          <input value={query} placeholder={t('browser.searchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)} aria-label={t('browser.searchAria')} />
          {searching ? <button className="preview-close" onClick={() => setQuery('')} aria-label={t('browser.clearSearch')}>×</button> : null}
        </div>
        {!searching ? (
          <>
            <select className="files-sort" value={sortKey} aria-label={t('browser.sortAria')}
              onChange={(e) => setSortKey(e.target.value as SortKey)} title={t('browser.sortAria')}>
              <option value="updated">{t('browser.sortUpdated')}</option>
              <option value="name">{t('browser.sortName')}</option>
              <option value="size">{t('browser.sortSize')}</option>
              <option value="type">{t('browser.sortType')}</option>
            </select>
            <div className="files-viewtoggle" role="group" aria-label={t('browser.viewMode')}>
              <button className={viewMode === 'grid' ? 'on' : ''} onClick={() => chooseView('grid')} title={t('browser.gridTitle')} aria-pressed={viewMode === 'grid'}>{t('browser.grid')}</button>
              <button className={viewMode === 'list' ? 'on' : ''} onClick={() => chooseView('list')} title={t('browser.listTitle')} aria-pressed={viewMode === 'list'}>{t('browser.list')}</button>
            </div>
          </>
        ) : null}
        <button
          className="btn ghost"
          style={{ opacity: 1 }}
          onClick={() => { setShowArchived((v) => !v); setSelected(null); }}
          title={t('browser.archivedTitle')}
        >
          {showArchived ? t('browser.hideArchived') : t('browser.showArchived')}
        </button>
        {/* ＋ New — a TYPE chooser (OS-wide pattern): "Upload a file" (the existing
            uploader) or "New note (markdown)" (a markdown editor that saves through the
            SAME raw-upload path, so no new storage plumbing). Both land in an Edit
            surface; opening the created file lands you in View. */}
        <div className="files-new" style={{ position: 'relative' }}>
          <button className="btn" onClick={() => setNewOpen((v) => !v)} disabled={uploading}
            aria-busy={uploading} aria-haspopup="menu" aria-expanded={newOpen}>
            {uploading ? <><span className="spin" /> {t('browser.uploading')}</> : t('browser.new')}
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
                  {t('browser.uploadFile')}
                </button>
                <button className="btn ghost sm" role="menuitem" style={{ justifyContent: 'flex-start' }}
                  onClick={() => { setNewOpen(false); setNoteOpen(true); }}>
                  {t('browser.newNote')}
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
              ? t('upload.uploadingCount', { count: uploads.length })
              : t('upload.doneCount', { done: uploads.filter((u) => u.state === 'done').length, total: uploads.length })}
          </div>
          {uploads.map((u, i) => (
            <div key={`${u.name}-${i}`} className={`upload-row upload-${u.state}`}>
              <span className="upload-name" title={u.name}>{u.name}</span>
              <span className="upload-pct">
                {u.state === 'error' ? t('upload.failed') : u.state === 'done' ? t('upload.done') : f8.number(u.pct / 100, { style: 'percent' })}
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
        title={t('browser.moveTitle', { count: pickerIds?.length ?? 1 })}
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
          if (!res.ok) { setErr(msg(await res.json(), t('errors.createFolder'))); return; }
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
        title={t('browser.moveFolderTitle')}
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
            if (!res.ok) { setErr(msg(await res.json(), t('errors.moveFolder'))); }
            else { refresh(); void loadFolders(); }
          } catch (e) { setErr((e as Error).message); }
        }}
        onCancel={() => setFolderMove(null)}
        onCreate={async (scope, path) => {
          const res = await fetch('/api/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: 'files', scope, path }),
          });
          if (!res.ok) { setErr(msg(await res.json(), t('errors.createFolder'))); return; }
          await loadFolders();
        }}
      />

      <FolderLayout
        allLabel={t('browser.allFiles')}
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
              personalLabel={t('browser.myFolders')}
              domainLabel={t('browser.domainFolders')}
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
                    if (!res.ok) { setErr(msg(await res.json(), t('errors.renameFolder'))); return; }
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
                  if (!await confirm(archiveCopy(folderName(ref.path), count, t))) return;
                  setErr('');
                  try {
                    // Materialise a registry row for a synthetic folder so it can be archived.
                    const id = await ensureFolderId('files', ref);
                    const res = await fetch(`/api/folders/${id}`, {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ action: 'archive' }),
                    });
                    if (!res.ok) { setErr(msg(await res.json(), t('errors.archiveFolder'))); return; }
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
                    if (!res.ok) { setErr(msg(await res.json(), t('errors.restoreFolder'))); return; }
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
                  if (!await confirm(deleteCopy(folderName(ref.path), count, t))) return;
                  setErr('');
                  try {
                    const res = await fetch(`/api/folders/${ref.id}`, { method: 'DELETE' });
                    if (!res.ok) { setErr(msg(await res.json(), t('errors.deleteFolder'))); return; }
                    if (sel?.path === ref.path) setSel(null);
                    refresh(); void loadFolders();
                  } catch (e) { setErr((e as Error).message); }
                })();
              }}
            />
            {facets.tags.length > 0 ? (
              <div>
                <p className="rail-group-title">{t('browser.tags')}</p>
                <div className="rail-tags">
                  {facets.tags.map((ft) => (
                    <button key={ft.tag} className={`chip${tag === ft.tag ? ' on' : ''}`} style={{ cursor: 'pointer' }}
                      onClick={() => setTag(tag === ft.tag ? null : ft.tag)}>{ft.tag} · {f8.number(ft.count)}</button>
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
              <div className="section-title">{t('browser.results')}<span className="count-pill">{hits?.length ?? 0}</span></div>
              {searchNote ? <div className="muted" role="status">{searchNote}</div> : null}
              {hits && hits.length === 0 ? <div className="stub-page">{t('browser.noMatch', { query })}</div> : null}
              {/* Search results reuse the SAME tile/row as browse (resolved from the
                  loaded scope list by id) so the tab reads as one product. */}
              {renderCollection(hitFiles, false)}
            </>
          ) : (
            <>
              {groups === null ? (
                <div className="stub-page"><span className="spin" /> {t('browser.loading')}</div>
              ) : filtered.length === 0 ? (
                <div className="stub-page">
                  {scope === 'mine' || scope === 'all'
                    ? t('browser.emptyMine')
                    : scope === 'shared' ? t('browser.emptyDomain') : t('browser.emptyCompany')}
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
                        aria-label={allInViewPicked ? t('browser.deselectAllAria') : t('browser.selectAllAria')}
                      />
                      {allInViewPicked ? t('browser.deselectAll') : t('browser.selectAll')}
                    </label>
                  </div>
                  {/* Bulk actions — appear once ≥1 card is ticked. Promote, Describe & tag and
                      Archive reuse the same per-file governed endpoints the detail view uses.
                      Promote also carries the gate PRE-FLIGHT: "3 of 12 ready to promote", and
                      is disabled with the gap named when none of the selection is ready. */}
                  {picked.size > 0 ? (
                    <div className="files-bulk" aria-busy={bulkBusy}>
                      <span>{t('bulk.selected', { count: picked.size })}</span>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => promptMove([...picked])}>{t('bulk.move')}</button>
                      <button className="btn ghost sm" disabled={bulkBusy || manageable.length === 0}
                        onClick={() => setDocsOpen(true)}
                        title={manageable.length === 0
                          ? t('bulk.describeNone')
                          : t('bulk.describeTitle')}>
                        {t('bulk.describe')}
                      </button>
                      <button className="btn ghost sm" disabled={bulkBusy || readiness.ready === 0}
                        onClick={() => void bulkPromote(pickedFiles)}
                        title={readiness.ready === 0
                          ? (readinessHintOf(readiness, t) || t('bulk.promoteNone'))
                          : t('bulk.promoteTitle')}>
                        {t('bulk.promote')}
                      </button>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => void bulkArchive(pickedFiles)}
                        title={t('bulk.archiveTitle')}>
                        {t('bulk.archive')}
                      </button>
                      <button className="btn ghost sm" disabled={bulkBusy}
                        onClick={() => { setPicked(new Set()); setBulkNotice(''); }}>{t('bulk.clear')}</button>
                      {/* The gate, read off the listing BEFORE the user presses Promote. */}
                      {promotable.length > 0 ? (
                        <span className="file-sub">{t('bulk.readiness', { ready: readiness.ready, total: readiness.total })}</span>
                      ) : null}
                      {readiness.blocked.length > 0 ? (
                        <span className="file-sub">{readinessHintOf(readiness, t)}</span>
                      ) : null}
                      {bulkBusy ? <span className="file-sub"><span className="spin" /> {t('bulk.working')}</span> : null}
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
                    {t('browser.archived')}<span className="count-pill">{archivedFiles.length}</span>
                  </div>
                  {renderCollection(archivedFiles, false)}
                </>
              ) : null}
            </>
          )}
      </FolderLayout>

      {/* ---- Describe & tag the selection — writes through the per-file PATCH route, then
              reports per file exactly like Promote does. ---- */}
      {docsOpen ? (
        <DescribeAndTagModal
          rows={manageable}
          busy={bulkBusy}
          onCancel={() => setDocsOpen(false)}
          onApply={(input) => { setDocsOpen(false); void bulkDescribeAndTag(manageable, input); }}
        />
      ) : null}

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
