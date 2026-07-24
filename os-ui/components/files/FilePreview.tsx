/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { previewText } from '@/lib/files/preview';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { useApprovalNotifier } from '@/components/lifecycle/useApprovalNotifier';
import type { FiledApproval } from '@/lib/governance/approval-notice';
import type { Visibility } from '@/lib/core/lifecycle';
import { canManageArtifact, type ArtifactScope } from '@/lib/governance/edit-scope';
import { FolderPickerModal } from '@/components/core/FolderTree';
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

export default function FilePreview({ id, onMutated, onClose }: { id: string; onMutated: () => void; onClose: () => void }) {
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
  // Folder picker modal state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [personalNodes, setPersonalNodes] = useState<FolderPathNode[]>([]);
  const [domainNodes, setDomainNodes] = useState<FolderPathNode[]>([]);

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

  const reupload = useCallback(async (file: File) => {
    const isText = /^text\/|json|csv|markdown/.test(file.type) || /\.(txt|md|csv|json|tsv)$/i.test(file.name);
    const text = isText ? await file.text() : undefined;
    setErr('');
    try {
      const res = await fetch(`/api/files/${id}/version`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, bytes: file.size }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Re-upload failed'); return; }
      await load();
      onMutated();
    } catch (e) { setErr((e as Error).message); }
  }, [id, load, onMutated]);

  // Delete goes through the shared ConfirmDialog (danger, physical); on success we
  // also close the now-orphaned preview pane.
  const onDeleted = useCallback(async () => {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? 'Delete failed'); return; }
    onMutated(); onClose();
  }, [id, onMutated, onClose]);

  if (err && !view) return <aside className="files-preview"><div className="error">{err}</div><button className="btn ghost" onClick={onClose}>Close</button></aside>;
  if (!view) return <aside className="files-preview"><span className="spin" /></aside>;

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

  return (
    <ConfirmProvider>
    <aside className="files-preview">
      <div className="preview-head">
        <div className="preview-row">
          <span className={`kind-chip kind-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
          <span className="preview-title">{a.name}</span>
        </div>
        <button className="preview-close" onClick={onClose} aria-label="Close preview">×</button>
      </div>

      <div className="preview-row">
        <span className={`status-chip ${a.indexing.mode === 'stored-only' ? 's-stored' : 's-searchable'}`}>
          {a.indexing.mode === 'stored-only' ? 'Stored only' : 'Searchable ✓'}
        </span>
        <span className="badge muted">{TIER_WORD[a.tier]}</span>
        <span className="file-sub">{a.version} · {bytesLabel(view.bytes)}</span>
      </div>

      {/* ---- Quick Look: render the ACTUAL file inline (the content is the hero).
              Original bytes stream from /raw with Content-Disposition: inline. CSV is
              rendered from the extracted text as a light table (no byte fetch needed).
              Below the viewer, the extracted text / transcript / caption stays for docs
              and media (searchable body); governance lives under the disclosure. ---- */}
      {mode && mode !== 'csv' ? (
        <div className="file-viewer">
          {mode === 'image' ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img className="viewer-image" src={rawSrc} alt={a.name} />
          ) : mode === 'pdf' ? (
            <iframe className="viewer-frame" src={rawSrc} title={a.name} />
          ) : mode === 'video' ? (
            <video className="viewer-media" src={rawSrc} controls />
          ) : (
            <audio className="viewer-media" src={rawSrc} controls />
          )}
        </div>
      ) : null}

      {mode === 'csv' && csvPreview ? (
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

      {view.text ? (
        <div>
          {mode ? <label className="rail-group-title">{isMedia ? 'Transcript' : 'Extracted text'}</label> : null}
          {/* `expanded` drops the fixed max-height so "Show all" actually reveals the
              full text (the box otherwise just scrolls inside a 240px clamp). */}
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

      {/* Quick actions live directly under the viewer — the two things a reader wants
          most (get the original, replace it). Governance sits under the disclosure. */}
      <div className="preview-row preview-actions">
        {/* Download: UI-uploaded files stream their ORIGINAL bytes from the object
            store; text-only (MCP) records download their extracted text as .txt. */}
        <a className="btn ghost sm" href={`/api/files/${id}/download`} download={a.name}>Download</a>
        <button className="btn ghost sm" onClick={() => reuploadRef.current?.click()}>Re-upload (new version)</button>
        <input ref={reuploadRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) reupload(f); e.target.value = ''; }} />
      </div>

      {err ? <div className="error">{err}</div> : null}

      {/* ---- Details & sharing: everything governance lives one click away so the file
              itself is the default focus (content is the hero). The controls are the
              SAME as before — only reflowed under a disclosure, not rewritten. ---- */}
      <details className="preview-details">
        <summary>Details &amp; sharing</summary>

      <dl className="preview-meta">
        <dt>Owner</dt><dd>{a.owner}</dd>
        <dt>Folder</dt><dd>{a.folder}</dd>
        <dt>Updated</dt><dd>{fresh(a.freshness)}</dd>
        <dt>Sharing</dt><dd>{a.visibility === 'Shared' ? 'Domain' : a.visibility === 'Certified' ? 'Company' : a.visibility}</dd>
        <dt>Storage</dt><dd>{a.storage}</dd>
        <dt>Link</dt><dd className="deep-link">{a.deepLink}</dd>
      </dl>

      {/* Move to folder — edit-gated (owner, or a domain_admin/admin once shared).
          The folder route also upserts the destination folder into the registry. */}
      {canManage ? (
        <div className="preview-row">
          <button
            className="btn ghost sm"
            onClick={() => { void loadFolders(); setPickerOpen(true); }}
            title="Move this file into a folder"
          >
            Move to folder…
          </button>
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

      {/* ---- Sharing lifecycle (governed exactly like Data): the OWNER (creator or
              builder) PROPOSES a promotion, a domain admin approves; an Admin certifies
              to the marketplace. The propose button is owner-gated, never role-gated —
              a builder proposes their OWN file; the approval is the governed gate. ---- */}
      <div className="preview-share" {...anchorAttr(ANCHORS.files.share)}>
        <label className="rail-group-title">Sharing</label>
        {a.tier === 'dataset' ? (
          promote?.request ? (
            <p className="hint" style={{ margin: 0 }}>⏳ Proposed — awaiting a domain admin’s approval…</p>
          ) : isOwner ? (
            <>
              {promote && !promote.gate.ok ? (
                <p className="hint" style={{ margin: '0 0 6px' }}>To propose sharing, add {promote.gate.missing.join(', ')}.</p>
              ) : null}
              <button className="btn ghost sm" disabled={!promote?.gate.ok} onClick={requestPromote}
                title="Propose sharing this file with your domain — a domain admin reviews it">
                Propose to Domain →
              </button>
            </>
          ) : <p className="hint" style={{ margin: 0 }}>Private to {a.owner}.</p>
        ) : a.tier === 'asset' ? (
          <div className="preview-row">
            <span className="hint" style={{ margin: 0 }}>Shared with your domain.</span>
            {isAdmin ? <button className="btn ghost sm" onClick={certify}>Certify to Company →</button> : null}
          </div>
        ) : (
          <span className="hint" style={{ margin: 0 }}>Published in the marketplace.</span>
        )}
      </div>

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

      {/* One consistent archive / delete / version-history cluster. Available to the
          owner, and — once the file is promoted — to an in-domain domain_admin or a
          platform admin, matching the server edit-scope. */}
      {canManage ? (
        <div className="preview-share">
          <label className="rail-group-title">Lifecycle</label>
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
        </div>
      ) : null}
      </details>
    </aside>
    </ConfirmProvider>
  );
}
