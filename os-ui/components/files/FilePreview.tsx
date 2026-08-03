/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { previewText } from '@/lib/files/preview';
import { reuploadVersion, saveTextVersion } from '@/lib/files/upload-client';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { useApprovalNotifier } from '@/components/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@/lib/governance/approval-notice';
import type { Visibility } from '@/lib/core/lifecycle';
import { canManageArtifact, type ArtifactScope } from '@/lib/governance/edit-scope';
import { FolderPickerModal } from '@/components/core/FolderTree';
import { usePublishPageContext } from '@/components/core/PageContext';
import type { FolderPathNode } from '@/lib/core/folders';

/** File tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: Asset['tier']): Visibility =>
  tier === 'asset' ? 'shared' : tier === 'product' ? 'certified' : 'personal';

/** Mirrors lib/files store FileAsset / FileView (the fields the pane shows). */
type Asset = {
  id: string; name: string; owner: string; domain: string;
  tier: 'dataset' | 'asset' | 'product'; visibility: string;
  kind: 'doc' | 'image' | 'video' | 'audio' | 'table' | 'archive' | 'other';
  folder: string; tags: string[]; sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
  freshness: string | null; version: string; deepLink: string; storage: string;
  indexing: { mode: 'indexed' | 'stored-only'; representations: string[] };
  description: string;
};
type StoredObject = { key: string; contentType: string; bytes: number };
type View = { asset: Asset; text: string; bytes: number; object?: StoredObject | null; history: { version: string; at: string }[]; archived?: boolean };
type Gate = { ok: boolean; missing: string[] };
type PromoteStatus = { tier: Asset['tier']; gate: Gate; request: { status: string } | null };
type LineageEdge = { id: string; kind: string; target: string; by: string; at: string };

const KIND_LABEL: Record<Asset['kind'], string> = {
  doc: 'DOC', image: 'IMG', audio: 'AUD', video: 'VID', table: 'TAB', archive: 'ZIP', other: 'FILE',
};
const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const;
// Scope vocabulary mirrors lib/core/scopes.ts (source of truth): Shared→"Domain", Certified→"Company".
const TIER_WORD: Record<Asset['tier'], string> = { dataset: 'Private', asset: 'Domain', product: 'Company' };

function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}
function fresh(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** How the Quick Look viewer should render the ORIGINAL bytes (served inline by
 *  /api/files/[id]/raw). Driven by the stored content-type — the only reliable signal
 *  for PDF-vs-text (both are kind `doc`). `null` → no inline viewer (text/other). */
type ViewerMode = 'image' | 'pdf' | 'video' | 'audio' | 'csv';
function viewerMode(contentType: string | undefined | null, name: string): ViewerMode | null {
  const t = (contentType ?? '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (t === 'text/csv' || /\.csv$/i.test(name)) return 'csv';
  return null;
}

/** Whether a file's content can be edited INLINE as text (an honest text editor) —
 *  plain text / markdown / code-ish files, driven by the stored content-type with a
 *  name-suffix fallback. Binary files (image/pdf/video/audio/archive/office) get
 *  Replace-file instead of a fake editor. CSV/table stays download-only for now (a
 *  free-text edit of a CSV is a footgun; Replace is the honest path). */
function isTextEditable(contentType: string | undefined | null, name: string, kind: Asset['kind']): boolean {
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'archive') return false;
  const t = (contentType ?? '').toLowerCase();
  if (t === 'application/pdf' || /\.pdf$/i.test(name)) return false;
  if (t === 'text/csv' || /\.csv$/i.test(name)) return false;
  if (t.startsWith('text/') || /json|markdown|xml|yaml/.test(t)) return true;
  return /\.(txt|md|markdown|json|log|xml|yaml|yml|tsv|sql|sh|env|ini|conf|toml)$/i.test(name);
}

/** Parse a small CSV preview into rows/cells (naive split — good enough for a calm
 *  glance; the file is downloadable for the real thing). Capped so a huge CSV never
 *  blows up the pane. */
function csvRows(text: string, maxRows = 30, maxCols = 12): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .slice(0, maxRows)
    .map((line) => line.split(',').slice(0, maxCols).map((c) => c.trim()));
}

export default function FilePreview({ id, onMutated, onClose, startInEdit }: { id: string; onMutated: () => void; onClose: () => void; startInEdit?: boolean }) {
  const { user, isAdmin } = useUser();
  const { notifyApprovalFiled } = useApprovalNotifier();
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [promote, setPromote] = useState<PromoteStatus | null>(null);
  const [lineage, setLineage] = useState<LineageEdge[]>([]);
  const [useAsMsg, setUseAsMsg] = useState('');
  const [showFullText, setShowFullText] = useState(false);
  const reuploadRef = useRef<HTMLInputElement>(null);
  // Re-upload progress: pct (0–100) while a new version is in flight, and its own
  // inline error — the same friendly vocabulary as the main uploader.
  const [reupPct, setReupPct] = useState<number | null>(null);
  const [reupErr, setReupErr] = useState('');
  // Folder picker modal state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [personalNodes, setPersonalNodes] = useState<FolderPathNode[]>([]);
  const [domainNodes, setDomainNodes] = useState<FolderPathNode[]>([]);
  // Inline rename of the filename (edit-gated, mirrors the other tabs).
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  // View ⇄ Edit — a file opens in VIEW (read the content); "✎ Edit" (edit-gated) reveals
  // the inline text editor (text/markdown) or Replace-file (binary). Save returns to View.
  const [editMode, setEditMode] = useState<'view' | 'edit'>(startInEdit ? 'edit' : 'view');
  const [bodyDraft, setBodyDraft] = useState('');
  const [savingBody, setSavingBody] = useState(false);
  const [bodyErr, setBodyErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const [fRes, pRes, lRes] = await Promise.all([
        fetch(`/api/files/${id}`, { cache: 'no-store' }),
        fetch(`/api/files/${id}/promote`, { cache: 'no-store' }),
        fetch(`/api/files/${id}/lineage`, { cache: 'no-store' }),
      ]);
      const data = await fRes.json();
      if (!fRes.ok) { setErr(data.error ?? 'Failed to load file'); return; }
      setView(data);
      setTagDraft((data.asset.tags ?? []).join(', '));
      setDescDraft(data.asset.description ?? '');
      if (pRes.ok) setPromote(await pRes.json());
      if (lRes.ok) setLineage((await lRes.json()).edges ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // Ground "Ask the OS" on the file open in Quick Look (its id + name + kind), so a
  // request like "summarize this" acts on THIS file without asking which. Clears on
  // unmount (the preview closes) so context never leaks to the next screen.
  usePublishPageContext({
    tab: 'files',
    artifactType: 'file',
    artifactId: id,
    artifactName: view?.asset.name,
    ...(view ? { extra: { kind: view.asset.kind } } : {}),
  });

  // The file detail is now a FULL-PAGE surface that replaces the browser (it scrolls with
  // the page, no inner scroll container). Esc returns to the file list — the same "← All
  // files" back affordance, from the keyboard. No body-scroll lock: the page owns the scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const loadFolders = useCallback(async () => {
    try {
      const [pRes, dRes] = await Promise.all([
        fetch('/api/folders?tab=files&scope=personal', { cache: 'no-store' }),
        fetch('/api/folders?tab=files&scope=domain', { cache: 'no-store' }),
      ]);
      if (pRes.ok) setPersonalNodes(((await pRes.json()).folders ?? []) as FolderPathNode[]);
      if (dRes.ok) setDomainNodes(((await dRes.json()).folders ?? []) as FolderPathNode[]);
    } catch { /* ignore */ }
  }, []);

  const requestPromote = useCallback(async () => {
    setErr('');
    const res = await fetch(`/api/files/${id}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (!res.ok) { setErr(data.error ?? 'Could not request promotion'); return; }
    // ONE OS-wide "this needs approval" confirmation (Policies link + inline approve).
    const approval = data.approval as FiledApproval | undefined;
    if (approval?.id) notifyApprovalFiled(approval, 'file', () => { void load(); onMutated(); });
    await load(); onMutated();
  }, [id, load, onMutated, notifyApprovalFiled]);

  const certify = useCallback(async () => {
    setErr('');
    const res = await fetch(`/api/files/${id}/transition`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transition: 'certify' }),
    });
    const data = await res.json();
    if (!res.ok) { setErr(data.error ?? 'Certify failed'); return; }
    await load(); onMutated();
  }, [id, load, onMutated]);

  const useAs = useCallback(async (target: 'knowledge' | 'data') => {
    setErr(''); setUseAsMsg('');
    const res = await fetch(`/api/files/${id}/use-as`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target }),
    });
    const data = await res.json();
    if (!res.ok) { setErr(data.error ?? 'Handoff failed'); return; }
    if (target === 'knowledge') setUseAsMsg(`Sent to Knowledge as a tacit note${data.ingested ? '' : ' (queued — index offline)'}.`);
    else setUseAsMsg(`Created Bronze dataset “${data.name}”. Open the Data tab to finish the guided import.`);
    await load();
  }, [id, load]);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    setErr('');
    try {
      const res = await fetch(`/api/files/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Update failed'); return; }
      await load();
      onMutated();
    } catch (e) { setErr((e as Error).message); }
  }, [id, load, onMutated]);

  // Rename the file (display name only — the object key/deep link are id/owner-based,
  // so the bytes never move). Edit-gated in the store; the affordance is canManage-only.
  const rename = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name) { setRenaming(false); return; }
    await patch({ name });
    setRenaming(false);
  }, [nameDraft, patch]);

  // Move this file into another folder via the edit-gated folder route. A viewer
  // (non-owner, non-admin) is rejected 403 by the store; the button is owner-only.
  const move = useCallback(async (folder: string) => {
    setErr('');
    try {
      const res = await fetch(`/api/files/${id}/folder`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Move failed'); return; }
      await load();
      onMutated();
    } catch (e) { setErr((e as Error).message); }
  }, [id, load, onMutated]);

  // Re-upload a NEW VERSION using the SAME robust XHR transport as the main uploader:
  // real progress + the shared friendly error vocabulary (too large / incomplete /
  // network). Keeps the /version endpoint + semantics — only the transport changed.
  const reupload = useCallback(async (file: File) => {
    const isText = /^text\/|json|csv|markdown/.test(file.type) || /\.(txt|md|csv|json|tsv)$/i.test(file.name);
    const text = isText ? await file.text() : undefined;
    setErr(''); setReupErr(''); setReupPct(0);
    const failure = await reuploadVersion(id, file, text, setReupPct);
    if (failure) { setReupErr(failure); setReupPct(null); return; }
    setReupPct(null);
    await load();
    onMutated();
  }, [id, load, onMutated]);

  // Save an INLINE text/markdown edit as a new version — through the honest text path
  // (rewriteBytes) so /raw, /download, the extracted text and search all stay in step.
  // Success returns to View (the read home of a saved file).
  const saveBody = useCallback(async () => {
    setBodyErr(''); setSavingBody(true);
    const failure = await saveTextVersion(id, bodyDraft, view?.asset.name ?? 'file');
    setSavingBody(false);
    if (failure) { setBodyErr(failure); return; }
    setEditMode('view');
    await load();
    onMutated();
  }, [id, bodyDraft, view?.asset.name, load, onMutated]);

  // Delete goes through the shared ConfirmDialog (danger, physical); on success we
  // also close the now-orphaned preview pane.
  const onDeleted = useCallback(async () => {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Delete failed'); return; }
    onMutated(); onClose();
  }, [id, onMutated, onClose]);

  if (err && !view) return (
    <div className="file-page">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onClose}>← All files</button>
      </div>
      <div className="error">{err}</div>
    </div>
  );
  if (!view) return (
    <div className="file-page">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onClose}>← All files</button>
      </div>
      <div className="stub-page"><span className="spin" /> Loading file…</div>
    </div>
  );

  const a = view.asset;
  const isOwner = user?.id === a.owner;
  // Client mirror of the server edit-scope (lib/files store `canEdit`): the OWNER
  // always, plus — once PROMOTED — an in-domain domain_admin or a platform admin.
  // A private (dataset-tier) file stays owner-only. Keeps the edit/move/lifecycle
  // affordances in step with what the API will actually allow, so a domain_admin/
  // admin sees the controls for a promoted file instead of a dead end.
  const editScope: ArtifactScope =
    a.tier === 'dataset' ? 'personal' : a.tier === 'product' ? 'certified' : 'shared';
  const canManage = user
    ? canManageArtifact({ id: user.id, role: user.role, domains: user.domains }, { owner: a.owner, domain: a.domain, scope: editScope })
    : false;
  const isMedia = a.kind === 'image' || a.kind === 'video' || a.kind === 'audio';

  /** Truncate very long extracted text; the reader can expand on demand. */
  const preview = previewText(view.text, showFullText);
  const textIsTruncated = preview.truncated;
  const textToShow = preview.body;

  // Quick Look: which inline viewer (if any) to render, and where the bytes live.
  // Only render an inline byte-viewer when ORIGINAL bytes are stored (view.object);
  // CSV renders from the already-extracted text, so it needs no stored object.
  const rawSrc = `/api/files/${id}/raw`;
  const rawMode = viewerMode(view.object?.contentType, a.name);
  // A byte-viewer (image/pdf/video/audio) needs stored original bytes; CSV renders
  // from the already-extracted text, so it does not.
  const mode = rawMode && rawMode !== 'csv' && !view.object ? null : rawMode;
  const csvPreview = mode === 'csv' && view.text ? csvRows(view.text) : null;

  // Is this file editable inline as text? (drives which Edit surface shows). Binary
  // files get Replace-file instead of a fake editor — never a fake editor.
  const textEditable = isTextEditable(view.object?.contentType, a.name, a.kind);
  // Enter Edit: seed the draft from the current extracted text (the honest source for a
  // text file — /raw of a text file is the same bytes). Save writes a new version.
  const enterEdit = () => { setBodyDraft(view.text); setBodyErr(''); setEditMode('edit'); };
  const inEdit = editMode === 'edit';

  return (
    <ConfirmProvider>
    <div className="file-page">
      {/* Full-page detail — this REPLACES the browser (it does not float over it). The
          content is the page and scrolls with the page scrollbar; "← All files" returns
          to the drive. Mirrors Metrics / Data. */}
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onClose}>← All files</button>
      </div>
      <div className="preview-head">
        <div className="preview-head-title">
          <div className="preview-row">
            <span className={`kind-chip kind-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
            {renaming ? (
              <span className="rename-inline">
                <input
                  className="rename-input"
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(false); }}
                  aria-label="File name"
                />
                <button className="btn primary sm" onClick={() => void rename()}>Save</button>
                <button className="btn ghost sm" onClick={() => setRenaming(false)}>Cancel</button>
              </span>
            ) : (
              <span className="preview-title">
                {a.name}
                {canManage ? (
                  <button
                    className="rename-pencil"
                    onClick={() => { setNameDraft(a.name); setRenaming(true); }}
                    title="Rename this file"
                    aria-label="Rename this file"
                  >✎</button>
                ) : null}
              </span>
            )}
          </div>
          <div className="preview-row preview-submeta">
            <span className={`status-chip ${a.indexing.mode === 'stored-only' ? 's-stored' : 's-searchable'}`}>
              {a.indexing.mode === 'stored-only' ? 'Stored only' : 'Searchable ✓'}
            </span>
            <span className="badge muted">{TIER_WORD[a.tier]}</span>
            <span className="file-sub">{a.version} · {bytesLabel(view.bytes)}</span>
          </div>
        </div>
        <div className="preview-head-actions">
          {/* View ⇄ Edit — edit-gated. text/markdown → inline editor; binary → Replace/rename/move
              (both live in the Edit surface below). The read view is always the default. */}
          {canManage ? (
            inEdit ? (
              <button className="btn ghost sm" onClick={() => { setEditMode('view'); setBodyErr(''); }} title="Back to the read view">View</button>
            ) : (
              <button className="btn ghost sm" onClick={enterEdit} title={textEditable ? 'Edit this file inline' : 'Replace, rename or move this file'}>✎ Edit</button>
            )
          ) : null}
          {view.object ? (
            <a className="btn ghost sm" href={rawSrc} target="_blank" rel="noreferrer" title="Open in a new tab">Open ↗</a>
          ) : null}
          <a className="btn ghost sm" href={`/api/files/${id}/download`} download={a.name}>Download</a>
        </div>
      </div>

      {/* ---- EDIT (text/markdown): an honest inline editor. Saving writes a NEW version
              through the /version endpoint with rewriteBytes, so /raw, /download, the
              extracted text and search all stay in step. Binary files never reach this
              branch — they get Replace-file below instead of a fake editor. ---- */}
      {inEdit && textEditable ? (
        <div className="file-editor">
          <label className="rail-group-title">{/\.(md|markdown)$/i.test(a.name) ? 'Markdown' : 'Text'}</label>
          <textarea
            className="mono"
            rows={18}
            value={bodyDraft}
            onChange={(e) => setBodyDraft(e.target.value)}
            aria-label="File content"
            style={{ width: '100%', resize: 'vertical' }}
          />
          <div className="preview-row" style={{ marginTop: 8 }}>
            <button className="btn primary sm" onClick={() => void saveBody()} disabled={savingBody || bodyDraft === view.text}>
              {savingBody ? <><span className="spin" /> Saving…</> : 'Save new version'}
            </button>
            <button className="btn ghost sm" onClick={() => { setEditMode('view'); setBodyErr(''); }} disabled={savingBody}>Cancel</button>
          </div>
          {bodyErr ? <div className="error" style={{ marginTop: 8 }}>{bodyErr}</div> : null}
        </div>
      ) : null}

      {/* ---- Quick Look: render the ACTUAL file inline (the content is the hero).
              Original bytes stream from /raw with Content-Disposition: inline. CSV is
              rendered from the extracted text as a light table (no byte fetch needed).
              Below the viewer, the extracted text / transcript / caption stays for docs
              and media (searchable body); governance lives under the disclosure. ---- */}
      {!inEdit && mode && mode !== 'csv' ? (
        <div className="file-viewer">
          {mode === 'image' ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img className="viewer-image" src={rawSrc} alt={a.name} />
          ) : mode === 'pdf' ? (
            // <object> renders the inline PDF (served as application/pdf +
            // Content-Disposition: inline by /raw). It falls back to <embed>, and if
            // the browser refuses to render a PDF at all, to a clear Open/Download link
            // — the file is never a dead end.
            <object className="viewer-frame" data={rawSrc} type="application/pdf" aria-label={a.name}>
              <embed className="viewer-frame" src={rawSrc} type="application/pdf" />
              <div className="media-stage">
                Preview isn’t available in this browser —{' '}
                <a href={rawSrc} target="_blank" rel="noreferrer">open in a new tab</a> or{' '}
                <a href={`/api/files/${id}/download`} download={a.name}>download</a>.
              </div>
            </object>
          ) : mode === 'video' ? (
            <video className="viewer-media" src={rawSrc} controls />
          ) : (
            <audio className="viewer-media" src={rawSrc} controls />
          )}
        </div>
      ) : null}

      {!inEdit && mode === 'csv' && csvPreview ? (
        <div className="viewer-table-wrap">
          <table className="viewer-table">
            <tbody>
              {csvPreview.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (ri === 0 ? <th key={ci}>{cell}</th> : <td key={ci}>{cell}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {inEdit ? null : view.text ? (
        <div>
          {mode ? <label className="rail-group-title">{isMedia ? 'Transcript' : 'Extracted text'}</label> : null}
          {/* Primary content — flows top-to-bottom with the PAGE scrollbar (no inner scroll
              box). "Show all" expands the DOM (previewText truncates the string for very
              long bodies); it is not a scroll clamp. */}
          <div className={`preview-text${showFullText ? ' expanded' : ''}`}>{textToShow}{textIsTruncated ? '…' : ''}</div>
          {preview.canToggle ? (
            <button className="btn ghost sm" style={{ marginTop: 4 }}
              onClick={() => setShowFullText((s) => !s)}>
              {showFullText ? 'Collapse text' : `Show all (${(view.text.length / 1000).toFixed(1)} K chars)`}
            </button>
          ) : null}
        </div>
      ) : mode ? null : (
        <div className="media-stage">No preview — download to view the original file.</div>
      )}

      {/* Replace file (new version) — the honest Edit path for BINARY files (and a valid
          option for text files too). Edit-gated + shown only in Edit. A new version
          streams over the shared XHR transport with inline progress. For a binary file
          this is the whole Edit surface: Replace here, rename in the header, move below.
          Never a fake editor. */}
      {inEdit && canManage ? (
        <div className="preview-actions">
          {!textEditable ? (
            <p className="hint" style={{ marginTop: 0 }}>
              No inline text — replace, rename or move it instead.
            </p>
          ) : null}
          <div className="preview-row">
            <button className="btn ghost sm" disabled={reupPct !== null} aria-busy={reupPct !== null}
              onClick={() => reuploadRef.current?.click()}>
              {reupPct !== null ? <><span className="spin" /> Uploading… {reupPct}%</> : 'Replace file (new version)'}
            </button>
            <input ref={reuploadRef} type="file" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f && reupPct === null) reupload(f); e.target.value = ''; }} />
          </div>
          {reupPct !== null ? (
            <div className="upload-bar" style={{ marginTop: 6 }}>
              <div className="upload-bar-fill" style={{ width: `${reupPct}%` }} />
            </div>
          ) : null}
          {reupErr ? <div className="error" style={{ marginTop: 6 }}>{reupErr}</div> : null}
        </div>
      ) : null}

      {/* Primary manage actions — ALWAYS VISIBLE (not buried in the disclosure): move
          the file to a folder + the archive/restore/delete cluster. Edit-gated. The
          descriptive metadata / tags stays under "Details & sharing" below. */}
      {canManage ? (
        <div className="preview-row preview-manage">
          <button
            className="btn ghost sm"
            onClick={() => { void loadFolders(); setPickerOpen(true); }}
            title="Move this file into a folder"
          >
            Move to folder…
          </button>
          <LifecycleActions
            id={id}
            name={a.name}
            kind="file"
            visibility={lcVis(a.tier)}
            archived={!!view.archived}
            api={`/api/files/${id}`}
            handlers={{ onDelete: onDeleted }}
            onChanged={onMutated}
            compact
          />
          <FolderPickerModal
            open={pickerOpen}
            tab="files"
            personalNodes={personalNodes}
            domainNodes={domainNodes}
            title="Move file to folder"
            onConfirm={({ path }) => { setPickerOpen(false); void move(path); }}
            onCancel={() => setPickerOpen(false)}
            onCreate={async (scope, path) => {
              const res = await fetch('/api/folders', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ tab: 'files', scope, path }),
              });
              if (!res.ok) { setErr((await res.json()).error ?? 'Could not create folder'); return; }
              await loadFolders();
            }}
          />
        </div>
      ) : null}

      {/* ---- Sharing lifecycle — ALSO ALWAYS VISIBLE (promote/demote must not be buried).
              Governed exactly like Data: the OWNER (creator or builder) PROPOSES a promotion,
              a domain admin approves; an Admin certifies to the marketplace. The propose
              button is owner-gated, never role-gated — the approval is the governed gate.
              Only the RENDER LOCATION moved out of the disclosure; the gate is unchanged. ---- */}
      <div className="preview-row preview-manage preview-share-row" {...anchorAttr(ANCHORS.files.share)}>
        <label className="rail-group-title">Sharing</label>
        {a.tier === 'dataset' ? (
          promote?.request ? (
            <span className="hint" style={{ margin: 0 }}>⏳ Proposed — awaiting a domain admin’s approval…</span>
          ) : isOwner ? (
            <>
              {promote && !promote.gate.ok ? (
                <span className="hint" style={{ margin: 0 }}>To propose sharing, add {promote.gate.missing.join(', ')}.</span>
              ) : null}
              <button className="btn ghost sm" disabled={!promote?.gate.ok} onClick={requestPromote}
                title="Propose sharing this file with your domain — a domain admin reviews it">
                Propose to Domain →
              </button>
            </>
          ) : <span className="hint" style={{ margin: 0 }}>Private to {a.owner}.</span>
        ) : a.tier === 'asset' ? (
          <>
            <span className="hint" style={{ margin: 0 }}>Shared with your domain.</span>
            {isAdmin ? <button className="btn ghost sm" onClick={certify}>Certify to Company →</button> : null}
          </>
        ) : (
          <span className="hint" style={{ margin: 0 }}>Published in the marketplace.</span>
        )}
      </div>

      {err ? <div className="error">{err}</div> : null}

      {/* ---- Details & sharing: everything governance lives one click away so the file
              itself is the default focus (content is the hero). The controls are the
              SAME as before — only reflowed under a disclosure, not rewritten. ---- */}
      <details className="preview-details">
        <summary>Details &amp; sharing</summary>

      <dl className="preview-meta">
        <dt>ID</dt><dd className="mono muted">{a.id}</dd>
        <dt>Owner</dt><dd>{a.owner}</dd>
        <dt>Folder</dt><dd>{a.folder}</dd>
        <dt>Updated</dt><dd>{fresh(a.freshness)}</dd>
        <dt>Sharing</dt><dd>{a.visibility === 'Shared' ? 'Domain' : a.visibility === 'Certified' ? 'Company' : a.visibility}</dd>
        <dt>Storage</dt><dd>{a.storage}</dd>
        <dt>Link</dt><dd className="deep-link">{a.deepLink}</dd>
      </dl>

      {/* Editable: description, tags, sensitivity, index opt-out. Shown to whoever
          may manage the file (owner, or a domain_admin/admin once it is promoted);
          hidden for a plain viewer, who would only hit a 403 on blur. */}
      {canManage ? (
        <>
          <div>
            <label className="rail-group-title">Description</label>
            <textarea rows={2} value={descDraft} placeholder="What is this file? (needed to share)"
              onChange={(e) => setDescDraft(e.target.value)}
              onBlur={() => { if (descDraft !== a.description) patch({ description: descDraft }); }} />
          </div>
          <div>
            <label className="rail-group-title">Tags</label>
            <input value={tagDraft} placeholder="comma, separated, tags"
              onChange={(e) => setTagDraft(e.target.value)}
              onBlur={() => patch({ tags: tagDraft.split(',').map((t) => t.trim()).filter(Boolean) })}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          </div>
          <div className="preview-row">
            <select value={a.sensitivity} onChange={(e) => patch({ sensitivity: e.target.value })} title="Sensitivity">
              {SENSITIVITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn ghost sm" title="Stored-only files are never indexed (sensitive/huge)"
              onClick={() => patch({ indexing: a.indexing.mode === 'indexed' ? 'stored-only' : 'indexed' })}
              disabled={a.sensitivity === 'restricted'}>
              {a.indexing.mode === 'indexed' ? 'Opt out of indexing' : 'Index this file'}
            </button>
          </div>
        </>
      ) : null}

      {/* ---- "Use as": distil the file into Knowledge (tacit note) or Data (Bronze). ---- */}
      <div className="preview-share">
        <label className="rail-group-title">Use as</label>
        <div className="preview-row">
          <button className="btn ghost sm" onClick={() => useAs('knowledge')} title="Send the parsed text to Knowledge as a tacit note">→ Knowledge</button>
          <button className="btn ghost sm" onClick={() => useAs('data')} title="Seed a guided Bronze dataset import in the Data tab">→ Data</button>
          {useAsMsg ? <a className="hint" style={{ margin: 0 }} href={useAsMsg.includes('Knowledge') ? '/knowledge' : '/data'}>✓ {useAsMsg}</a> : null}
        </div>
      </div>

      {lineage.length > 0 ? (
        <div>
          <label className="rail-group-title">Lineage</label>
          <ul className="lineage-list">
            {lineage.map((e) => (
              <li key={e.id}><span className="mono">{e.kind}</span> → {e.target} <span className="file-sub">· {e.by}</span></li>
            ))}
          </ul>
        </div>
      ) : null}

      </details>
    </div>
    </ConfirmProvider>
  );
}
