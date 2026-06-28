/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import ArtifactPanel from '@/components/ArtifactPanel';

type Hit = { id: string; score: number; title: string; text: string };
type Result = { query: string; total: number; index: string; hits: Hit[] };

const EXAMPLES = ['retrieval backbone', 'observability', 'sovereign', 'model gateway'];

const CATEGORIES = [
  { n: '1', title: 'The workflow, step by step', desc: 'What happens, in order — the procedure itself.' },
  { n: '2', title: 'Rules and decisions', desc: 'The if/then logic, thresholds, and approvals.' },
  { n: '3', title: 'Tacit business context', desc: 'The why, the exceptions, the unwritten know-how.' },
];

const STARTERS = [
  'Capture our monthly invoice-reconciliation workflow.',
  'Document the customer-refund approval process.',
  'Capture domain-level context for our logistics operation.',
];

export default function KnowledgePage() {
  const [tab, setTab] = useState<'search' | 'author' | 'workspace'>('search');

  // search
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  async function search(query: string) {
    const text = query.trim();
    if (!text || loading) return;
    setLoading(true);
    setError('');
    setResult(null);
    setSearched(true);
    try {
      const res = await fetch(`/api/knowledge?q=${encodeURIComponent(text)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Search failed');
      else setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // author
  const [draft, setDraft] = useState('');
  const [docTitle, setDocTitle] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [authorMsg, setAuthorMsg] = useState('');
  const [authorError, setAuthorError] = useState('');

  function download() {
    if (!draft.trim()) return;
    const blob = new Blob([draft], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(docTitle || 'knowledge').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function ingest() {
    if (!draft.trim() || ingesting) return;
    setIngesting(true);
    setAuthorMsg('');
    setAuthorError('');
    try {
      const res = await fetch('/api/knowledge/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: docTitle.trim() || 'Knowledge file', text: draft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) setAuthorError(data.error ?? 'Ingest failed');
      else setAuthorMsg(`Ingested “${data.title}” into the knowledge index — agents' RAG can now retrieve it.`);
    } catch (e) {
      setAuthorError((e as Error).message);
    } finally {
      setIngesting(false);
    }
  }

  return (
    <>
      <PageHeader title="Knowledge" crumb="author & search .md knowledge — knowledge agent + OpenSearch" />
      <div className="content">
        <p className="lead">
          Capture and search the curated knowledge that grounds the agents. The knowledge agent
          helps you author a structured markdown file per workflow; search runs over the same
          OpenSearch index the RAG retrieves from.
        </p>

        <div className="tabstrip">
          <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>Search</button>
          <button className={tab === 'author' ? 'active' : ''} onClick={() => setTab('author')}>Author with the knowledge agent</button>
          <button className={tab === 'workspace' ? 'active' : ''} onClick={() => setTab('workspace')}>My knowledge docs</button>
        </div>

        {tab === 'workspace' ? (
          <ArtifactPanel
            type="knowledge"
            createLabel="Create knowledge doc"
            specFields={[{ key: 'index', label: 'Target index', placeholder: 'knowledge' }]}
            renderSpec={(a) => (a.spec?.index ? <div className="muted mono" style={{ fontSize: 11 }}>index: {String(a.spec.index)}</div> : null)}
            intro={
              <p className="hint" style={{ marginTop: 0 }}>
                Track knowledge docs as artifacts through the lifecycle. Ingestion into the live
                OpenSearch index happens on the Author tab; here you manage visibility (Personal →
                Shared → Certified) and reuse.
              </p>
            }
          />
        ) : null}

        {tab === 'search' ? (
          <>
            <form onSubmit={(e) => { e.preventDefault(); search(q); }}>
              <div className="row" style={{ gap: 10 }}>
                <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search knowledge…" />
                <button className="btn" type="submit" disabled={loading || !q.trim()}>
                  {loading ? <span className="spin" /> : 'Search'}
                </button>
              </div>
              <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap' }}>
                {EXAMPLES.map((ex) => (
                  <button type="button" key={ex} className="chip" style={{ cursor: 'pointer', background: 'transparent' }}
                    onClick={() => { setQ(ex); search(ex); }}>{ex}</button>
                ))}
              </div>
            </form>
            <div style={{ marginTop: 24 }}>
              {error ? <div className="error">{error}</div> : null}
              {result ? (
                <>
                  <div className="section-title">
                    {result.total} hit{result.total === 1 ? '' : 's'} · index <code>{result.index}</code>
                  </div>
                  {result.hits.length === 0 ? (
                    <div className="stub-page">No documents matched “{result.query}”.</div>
                  ) : (
                    <div style={{ display: 'grid', gap: 12 }}>
                      {result.hits.map((h) => (
                        <div className="result" key={h.id}>
                          <div className="result-head">
                            <h4>{h.title}</h4>
                            <span className="score">score {h.score.toFixed(3)}</span>
                          </div>
                          <p className="result-text">{h.text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : !searched ? (
                <div className="stub-page">Try a query above — e.g. “retrieval backbone”.</div>
              ) : null}
            </div>
          </>
        ) : null}

        {tab === 'author' ? (
          <>
            <div className="section-title">Three categories per workflow</div>
            <div className="grid">
              {CATEGORIES.map((c) => (
                <div className="card" key={c.n}>
                  <h3>Section {c.n}</h3>
                  <div className="big" style={{ fontSize: 16 }}>{c.title}</div>
                  <div className="muted" style={{ marginTop: 6 }}>{c.desc}</div>
                </div>
              ))}
            </div>

            <div className="section-title">Knowledge agent</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Describe a workflow (or domain context). The agent asks focused questions and
              produces a structured .md under the three headings above. Its latest reply is
              captured below as the draft — edit, download, or ingest it.
            </p>
            <AgentChat
              agent="knowledge"
              label="knowledge agent"
              placeholder="e.g. Capture how we onboard a new supplier, step by step…"
              starters={STARTERS}
              onAssistant={(content) => setDraft(content)}
            />

            <div className="section-title">Knowledge file (.md draft)</div>
            <input type="text" value={docTitle} onChange={(e) => setDocTitle(e.target.value)} placeholder="Title for this knowledge file…" />
            <textarea
              className="mono"
              rows={12}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'The agent\'s latest reply lands here. You can also paste/edit markdown directly:\n\n## 1. The workflow, step by step\n## 2. Rules and decisions\n## 3. Tacit business context'}
              style={{ marginTop: 10 }}
            />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn ghost" onClick={download} disabled={!draft.trim()}>Download .md</button>
              <button className="btn" onClick={ingest} disabled={ingesting || !draft.trim()}>
                {ingesting ? <span className="spin" /> : 'Ingest into knowledge'}
              </button>
            </div>
            {authorError ? <div className="error" style={{ marginTop: 12 }}>{authorError}</div> : null}
            {authorMsg ? <div className="hint" style={{ marginTop: 12, color: 'var(--teal)' }}>✓ {authorMsg}</div> : null}
          </>
        ) : null}
      </div>
    </>
  );
}
