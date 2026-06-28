/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ArtifactPanel from '@/components/ArtifactPanel';

type Doc = { id: string; title: string; excerpt: string; source: string; ingestedAt: string | null };
type Classification = { source: string; description: string; contentType: string; tags: string[] };

// Source connectors for unstructured data (scaffolded — selecting one opens the
// connector setup, which is built on the Connections tab).
const SOURCES = [
  { name: 'OneDrive', detail: 'Microsoft 365 files & folders', auth: 'OAuth2', available: false },
  { name: 'SharePoint', detail: 'Document libraries', auth: 'OAuth2', available: false },
  { name: 'Google Drive', detail: 'Docs, PDFs, images', auth: 'OAuth2', available: false },
  { name: 'S3 / Object storage', detail: 'Buckets of documents', auth: 'access key', available: true },
  { name: 'Local upload', detail: 'Paste or upload a file', auth: 'none', available: true },
];

function fmt(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function UnstructuredPage() {
  const [tab, setTab] = useState<'library' | 'files' | 'add' | 'sources'>('library');

  // library
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [listError, setListError] = useState('');
  const [loadingDocs, setLoadingDocs] = useState(true);

  const loadDocs = useCallback(async () => {
    setLoadingDocs(true);
    setListError('');
    try {
      const res = await fetch('/api/knowledge/docs', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) setListError(data.error ?? 'Failed to load documents');
      else {
        setDocs(data.docs ?? []);
        setTotal(data.total ?? 0);
      }
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // add & classify
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [classifying, setClassifying] = useState(false);
  const [cls, setCls] = useState<Classification | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [okMsg, setOkMsg] = useState('');

  async function classify() {
    if ((!text.trim() && !title.trim()) || classifying) return;
    setClassifying(true);
    setFormError('');
    setCls(null);
    try {
      const res = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), text: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) setFormError(data.error ?? 'Classification failed');
      else setCls(data);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setClassifying(false);
    }
  }

  async function ingest() {
    if (!text.trim() || submitting) return;
    setSubmitting(true);
    setFormError('');
    setOkMsg('');
    // Fold the classification (when present) into the curated doc.
    const meta = cls
      ? `\n\n---\nclassification: ${cls.contentType}\ntags: ${cls.tags.join(', ')}\ndescription: ${cls.description}`
      : '';
    try {
      const res = await fetch('/api/knowledge/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), text: text.trim() + meta }),
      });
      const data = await res.json();
      if (!res.ok) setFormError(data.error ?? 'Ingest failed');
      else {
        setOkMsg(`Curated “${data.title}” into the knowledge index.`);
        setTitle('');
        setText('');
        setCls(null);
        loadDocs();
      }
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="Unstructured Data" crumb="catalog · classify · curate — OpenMetadata / OpenSearch" />
      <div className="content">
        <p className="lead">
          Documents, PDFs, and notes: catalog them, classify &amp; describe them for the domain
          with an LLM, and curate selected items into Knowledge for RAG. The catalog uses
          OpenMetadata when it&apos;s on; otherwise it falls back to the OpenSearch knowledge index.
        </p>

        <div className="tabstrip">
          <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>Library</button>
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>My files</button>
          <button className={tab === 'add' ? 'active' : ''} onClick={() => setTab('add')}>Add &amp; classify</button>
          <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>Sources</button>
        </div>

        {tab === 'files' ? (
          <ArtifactPanel
            type="file"
            createLabel="Register file"
            specFields={[
              { key: 'kind', label: 'File type', placeholder: 'pdf | image | video | audio | doc' },
              { key: 'location', label: 'Location', placeholder: 'object-storage prefix / URL' },
            ]}
            renderSpec={(a) => (a.spec?.kind || a.spec?.location ? (
              <div className="muted mono" style={{ fontSize: 11 }}>{a.spec?.kind ? <>type: {String(a.spec.kind)}<br /></> : null}{a.spec?.location ? <>at: {String(a.spec.location)}</> : null}</div>
            ) : null)}
            intro={
              <p className="hint" style={{ marginTop: 0 }}>
                Files you (and your domain) own, share, or added from the Marketplace — same Personal →
                Shared → Certified lifecycle as every artifact. Binary content lands in object storage
                (never Supabase); curate selected items into Knowledge for RAG under &quot;Add &amp; classify&quot;.
              </p>
            }
          />
        ) : null}

        {tab === 'library' ? (
          <>
            <div className="section-title">
              Documents
              {total ? <span className="count-pill ok">{total} indexed</span> : null}
              {loadingDocs ? <span className="spin" /> : null}
              <button className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 12px' }} onClick={loadDocs} disabled={loadingDocs}>
                Refresh
              </button>
            </div>
            {listError ? <div className="error">{listError}</div> : null}
            {!listError && !loadingDocs && docs.length === 0 ? (
              <div className="stub-page">No documents yet — add one under “Add &amp; classify”.</div>
            ) : null}
            {docs.length > 0 ? (
              <div style={{ display: 'grid', gap: 12 }}>
                {docs.map((d) => (
                  <div className="result" key={d.id}>
                    <div className="result-head">
                      <h4>{d.title}</h4>
                      <span className="score">{d.source}{d.ingestedAt ? ` · ${fmt(d.ingestedAt)}` : ''}</span>
                    </div>
                    {d.excerpt ? <p className="result-text">{d.excerpt}</p> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {tab === 'add' ? (
          <>
            <div className="section-title">Add a document</div>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)…" />
            <textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste document text… (file upload via Docling enables when the parser is on)"
              style={{ marginTop: 10 }}
            />
            <div className="row" style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="hint" style={{ marginTop: 0 }}>
                Classify &amp; describe runs the LLM (via LiteLLM) over the text for the domain.
              </div>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn ghost" disabled title="Enable Docling to upload files">Upload file</button>
                <button className="btn ghost" onClick={classify} disabled={classifying || (!text.trim() && !title.trim())}>
                  {classifying ? <span className="spin" /> : 'Classify & describe'}
                </button>
                <button className="btn" onClick={ingest} disabled={submitting || !text.trim()}>
                  {submitting ? <span className="spin" /> : 'Curate to Knowledge'}
                </button>
              </div>
            </div>

            {cls ? (
              <div className="answer" style={{ marginTop: 14 }}>
                <div className="bubble-role">Classification · via {cls.source}</div>
                <div style={{ marginTop: 6 }}><strong>Type:</strong> {cls.contentType}</div>
                <div style={{ marginTop: 4 }}><strong>Description:</strong> {cls.description}</div>
                <div className="sources" style={{ marginTop: 8 }}>
                  {cls.tags.map((t) => <span className="chip" key={t}>{t}</span>)}
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  Curating to Knowledge stores the text plus this classification.
                </div>
              </div>
            ) : null}

            {formError ? <div className="error" style={{ marginTop: 12 }}>{formError}</div> : null}
            {okMsg ? <div className="hint" style={{ marginTop: 12, color: 'var(--teal)' }}>✓ {okMsg}</div> : null}
          </>
        ) : null}

        {tab === 'sources' ? (
          <>
            <div className="section-title">Connect a source</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
              Pull unstructured data from an external source. Selecting a connector opens the
              setup flow (built on the Connections tab). Connector build is <strong>scaffolded</strong> in v1.
            </p>
            <div className="grid">
              {SOURCES.map((s) => (
                <div className="card" key={s.name}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: 0 }}>{s.name}</h3>
                    <span className={`badge ${s.available ? 'ok' : 'muted'}`}>{s.available ? 'available' : 'roadmap'}</span>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>{s.detail}</div>
                  <div className="muted mono" style={{ marginTop: 6, fontSize: 11.5 }}>Auth: {s.auth}</div>
                  <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                    <a className="btn ghost" href="/connections">{s.available ? 'Set up →' : 'Soon'}</a>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
