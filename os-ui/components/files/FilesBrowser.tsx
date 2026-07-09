/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/core/scopes';
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

function FileCard({ f, on, onOpen }: { f: Summary; on: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={`file-card${on ? ' on' : ''}`} onClick={onOpen}>
      <div className="file-card-top">
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

export default function FilesBrowser() {
  const { user } = useUser();
  const [scope, setScope] = useState<ScopeKey>('mine');
  const [groups, setGroups] = useState<Groups | null>(null);
  const [err, setErr] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // ?archived=1 additionally returns soft-archived files (their own section), so an
  // archived file stays openable → its preview exposes Restore + Delete (OS-wide rule).
  const [showArchived, setShowArchived] = useState(false);

  // search
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);

  // upload / drag-drop
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch(`/api/files${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load files'); return; }
      setGroups(data);
    } catch (e) { setErr((e as Error).message); }
  }, [showArchived]);
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
      form.append('folder', folder ?? '/');
      try {
        const res = await fetch('/api/files', { method: 'POST', body: form });
        if (!res.ok) { setErr((await res.json()).error ?? 'Upload failed'); }
      } catch (e) { setErr((e as Error).message); }
    }
    refresh();
  }, [folder, refresh]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    if (e.dataTransfer.files?.length) upload(e.dataTransfer.files);
  }, [upload]);

  const uid = user?.id ?? '';
  const scoped = groups ? groupByScope(groups, uid) : null;
  const counts = groups ? scopeCounts(groups, uid) : null;
  const list = scoped ? scoped[scope] : [];
  const facets = groups?.facets ?? { folders: [], tags: [] };
  const matched = list.filter((f) => (!folder || f.folder === folder) && (!tag || f.tags.includes(tag)));
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
              onClick={() => { setScope(g.key); setFolder(null); setTag(null); setSelected(null); }}>
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
          style={{ opacity: showArchived ? 1 : 0.7 }}
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

      <div className={`files-layout${selected ? ' with-preview' : ''}`}>
        {/* ---- folder rail + tag cloud (the owner's drive) ---- */}
        <nav className="files-rail">
          <div>
            <p className="rail-group-title">Folders</p>
            <button className={`rail-item${folder === null ? ' on' : ''}`} onClick={() => setFolder(null)}>
              <span>All files</span><span className="rail-count">{list.length}</span>
            </button>
            {facets.folders.map((f) => (
              <button key={f.path} className={`rail-item${folder === f.path ? ' on' : ''}`}
                onClick={() => setFolder(folder === f.path ? null : f.path)}>
                <span>{f.path === '/' ? '/ (root)' : f.path}</span><span className="rail-count">{f.count}</span>
              </button>
            ))}
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
                    : `Nothing ${scope === 'shared' ? 'shared in your domain' : 'in the marketplace'} yet.`}
                </div>
              ) : (
                <div className="file-grid">
                  {filtered.map((f) => (
                    <FileCard key={f.id} f={f} on={selected === f.id} onOpen={() => setSelected(f.id)} />
                  ))}
                </div>
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
