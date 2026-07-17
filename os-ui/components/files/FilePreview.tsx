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
type View = { asset: Asset; text: string; bytes: number; history: { version: string; at: string }[]; archived?: boolean };
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
  const isMedia = a.kind === 'image' || a.kind === 'video' || a.kind === 'audio';

  /** Truncate very long extracted text; the reader can expand on demand. */
  const preview = previewText(view.text, showFullText);
  const textIsTruncated = preview.truncated;
  const textToShow = preview.body;

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

      {/* The extracted text / transcript / caption — the only "preview" we surface;
          the raw bytes are available via the Download button (a Phase-5 concern). */}
      {isMedia ? (
        <div className="media-stage">
          {a.kind === 'image' ? 'Image — download to view' : a.kind === 'audio' ? 'Audio — transcript below' : 'Video — transcript below'}
        </div>
      ) : null}
      {view.text ? (
        <div>
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
      ) : (
        <div className="media-stage">Extracted text appears once the file is indexed.</div>
      )}

      <dl className="preview-meta">
        <dt>Owner</dt><dd>{a.owner}</dd>
        <dt>Folder</dt><dd>{a.folder}</dd>
        <dt>Updated</dt><dd>{fresh(a.freshness)}</dd>
        <dt>Sharing</dt><dd>{a.visibility === 'Shared' ? 'Domain' : a.visibility === 'Certified' ? 'Company' : a.visibility}</dd>
        <dt>Storage</dt><dd>{a.storage}</dd>
        <dt>Link</dt><dd className="deep-link">{a.deepLink}</dd>
      </dl>

      {/* Move to folder — edit-gated (owner / in-domain admin). The folder route
          also upserts the destination folder into the governed registry. */}
      {isOwner || isAdmin ? (
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

      {/* Editable: description, tags, sensitivity, index opt-out (owner-only; 403 otherwise). */}
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

      {err ? <div className="error">{err}</div> : null}

      <div className="preview-row" style={{ justifyContent: 'space-between', marginTop: 'auto' }}>
        {/* Download: UI-uploaded files stream their ORIGINAL bytes from the object
            store; text-only (MCP) records download their extracted text as .txt. */}
        <a className="btn ghost sm" href={`/api/files/${id}/download`} download={a.name}>Download</a>
        <button className="btn ghost sm" onClick={() => reuploadRef.current?.click()}>Re-upload (new version)</button>
        <input ref={reuploadRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) reupload(f); e.target.value = ''; }} />
      </div>

      {/* One consistent archive / delete / version-history cluster (owner-only). */}
      {isOwner ? (
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
    </aside>
    </ConfirmProvider>
  );
}
