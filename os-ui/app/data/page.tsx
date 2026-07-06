/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import SandboxLane from '@/components/SandboxLane';
import DataTab from '@/components/data/DataTab';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';

type QueryResult = {
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};
type Asset = { name: string; fqn: string; description: string; type: string; source?: string; datasetId?: string };
type CatalogSourceStatus = { source: string; ok: boolean; count: number; status: string };
type Catalog = { source: string; note?: string; sources?: CatalogSourceStatus[]; assets: Asset[] };
type Answer = { question: string; answer: string; retrieved: string[]; traced: boolean };
type AskDataResult = {
  ok: boolean;
  kind?: 'no_dataset' | 'invalid_sql' | 'query_failed';
  error?: string;
  sql?: string | null;
  columns?: string[];
  rows?: string[][];
  rowCount?: number;
  answer?: string;
  traced?: boolean;
};

const DEFAULT_SQL =
  'select order_date, revenue, orders\nfrom daily_revenue\norder by order_date';
const ASK_EXAMPLES = [
  'What provides the retrieval backbone for vector and lexical search?',
  'How does the platform stay sovereign?',
  'What gives observability and tracing?',
];
const ASK_DATA_EXAMPLES = [
  'Total revenue by region',
  'How many orders were placed, by month?',
  'Which region has the highest average order value?',
];

// Datasets (tiles → Bronze/Silver/Gold) is the primary surface; Query and "Talk to
// your data" are kept as secondary tabs (locked decision), with My data (sandbox)
// and the read-only Catalog alongside.
type View = 'datasets' | 'mydata' | 'catalog' | 'ask' | 'query';

export default function DataPage() {
  const [view, setView] = useState<View>('datasets');

  // ---- catalog ----
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catError, setCatError] = useState('');
  const loadCatalog = useCallback(async () => {
    setCatError('');
    try {
      const res = await fetch('/api/catalog', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) setCatError(data.error ?? 'Failed to load catalog');
      else setCatalog(data);
    } catch (e) {
      setCatError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  // ---- talk to your data: two modes — NL→SQL over your datasets, RAG over docs ----
  const [askMode, setAskMode] = useState<'data' | 'docs'>('data');
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [dataAnswer, setDataAnswer] = useState<AskDataResult | null>(null);
  const [askError, setAskError] = useState('');
  const askDocs = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || asking) return;
      setAsking(true);
      setAskError('');
      setAnswer(null);
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question }),
        });
        const data = await res.json();
        if (!res.ok) setAskError(data.error ?? 'Request failed');
        else setAnswer(data);
      } catch (e) {
        setAskError((e as Error).message);
      } finally {
        setAsking(false);
      }
    },
    [asking],
  );
  const askData = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || asking) return;
      setAsking(true);
      setAskError('');
      setDataAnswer(null);
      try {
        const res = await fetch('/api/data/ask', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question }),
        });
        const data = await res.json();
        // Honest states (no dataset / rejected SQL / query refusal) carry a `kind`
        // and are rendered as answers, not as a generic failure banner.
        if (!res.ok && !data.kind) setAskError(data.error ?? 'Request failed');
        else setDataAnswer(data);
      } catch (e) {
        setAskError((e as Error).message);
      } finally {
        setAsking(false);
      }
    },
    [asking],
  );
  const ask = askMode === 'data' ? askData : askDocs;

  // ---- query ----
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [qError, setQError] = useState('');
  const run = useCallback(
    async (query?: string) => {
      const text = (query ?? sql).trim();
      if (!text || running) return;
      if (query) setSql(query);
      setRunning(true);
      setQError('');
      setResult(null);
      try {
        const res = await fetch('/api/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql: text }),
        });
        const data = await res.json();
        if (!res.ok) setQError(data.error ?? 'Query failed');
        else setResult(data);
      } catch (e) {
        setQError((e as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [sql, running],
  );
  const preview = useCallback((fqn: string) => {
    const bare = fqn.includes('.') ? fqn.split('.').pop()! : fqn;
    setView('query');
    run(`select * from ${bare} limit 50`);
  }, [run]);

  return (
    <>
      <PageHeader title="Data" crumb="datasets · personal data · catalog · talk to your data · query" tutorial="data" />
      <div className="content">
        <div className="tabstrip">
          <button className={view === 'datasets' ? 'active' : ''} onClick={() => setView('datasets')}>Datasets</button>
          <button className={view === 'mydata' ? 'active' : ''} onClick={() => setView('mydata')} {...anchorAttr(ANCHORS.data.sandbox)}>Personal data</button>
          <button className={view === 'catalog' ? 'active' : ''} onClick={() => setView('catalog')} {...anchorAttr(ANCHORS.data.document)}>Catalog</button>
          <button className={view === 'ask' ? 'active' : ''} onClick={() => setView('ask')}>Talk to your data</button>
          <button className={view === 'query' ? 'active' : ''} onClick={() => setView('query')} {...anchorAttr(ANCHORS.data.query)}>Query</button>
        </div>

        {view === 'datasets' ? <DataTab /> : null}

        {view === 'mydata' ? <SandboxLane /> : null}

        {view === 'catalog' ? (
          <>
            <div className="section-title">
              Structured data assets
              {catalog ? (
                <span className="count-pill ok">{catalog.assets.length} across {catalog.sources?.length ?? 1} source{(catalog.sources?.length ?? 1) === 1 ? '' : 's'}</span>
              ) : null}
            </div>
            {/* Honest per-source status: registry is always here; Trino + OpenMetadata
                report exactly why they did or didn't contribute — no silent fallback. */}
            {catalog?.sources ? (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {catalog.sources.map((s) => (
                  <span key={s.source} className={`count-pill ${s.ok ? 'ok' : ''}`} title={s.status}>
                    {s.source}: {s.ok ? `${s.count}` : '—'} · {s.status}
                  </span>
                ))}
              </div>
            ) : null}
            {catalog?.note ? <p className="hint" style={{ marginTop: 0 }}>{catalog.note}</p> : null}
            {catError ? <div className="error">{catError}</div> : null}
            {catalog ? (
              catalog.assets.length === 0 ? (
                <div className="stub-page">No assets in the catalog yet.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Type</th>
                        <th>Source</th>
                        <th>Fully-qualified name</th>
                        <th>Description</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.assets.map((a) => (
                        <tr key={`${a.source ?? ''}:${a.fqn}`}>
                          <td style={{ fontWeight: 600 }}>{a.name}</td>
                          <td>{a.type}</td>
                          <td>{a.source ? <span className="chip">{a.source}</span> : '—'}</td>
                          <td className="mono">{a.fqn}</td>
                          <td className="muted" style={{ whiteSpace: 'normal' }}>{a.description || '—'}</td>
                          <td>
                            {/* A not-yet-materialized registry entry has no physical
                                table to preview — say so honestly instead of a bad query. */}
                            {a.fqn.startsWith('registry:') ? (
                              <span className="muted">not materialized</span>
                            ) : (
                              <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => preview(a.fqn)}>
                                Preview →
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : !catError ? (
              <div className="stub-page">Loading catalog…</div>
            ) : null}
          </>
        ) : null}

        {view === 'ask' ? (
          <>
            <div className="section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span>Talk to your data</span>
              <span className="seg">
                <button type="button" className={askMode === 'data' ? 'on' : ''} onClick={() => { setAskMode('data'); setAskError(''); }}>
                  Your data
                </button>
                <button type="button" className={askMode === 'docs' ? 'on' : ''} onClick={() => { setAskMode('docs'); setAskError(''); }}>
                  Your documents
                </button>
              </span>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              {askMode === 'data'
                ? 'Ask in plain language. The OS writes one governed, read-only SQL query over the datasets you can see, runs it as you, and answers from the returned rows — with the SQL shown.'
                : 'Ask the domain RAG agent (sample-agent on LangGraph). It retrieves from your knowledge (OpenSearch), generates via LiteLLM, and traces in Langfuse.'}
            </p>
            <form onSubmit={(e) => { e.preventDefault(); ask(q); }}>
              <textarea
                rows={3}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={askMode === 'data' ? 'Ask a question about your datasets…' : 'Ask a question about your documents…'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(q); }
                }}
              />
              <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {(askMode === 'data' ? ASK_DATA_EXAMPLES : ASK_EXAMPLES).map((ex) => (
                    <button type="button" key={ex} className="chip" style={{ cursor: 'pointer', background: 'transparent' }}
                      onClick={() => { setQ(ex); ask(ex); }}>
                      {ex.length > 42 ? `${ex.slice(0, 42)}…` : ex}
                    </button>
                  ))}
                </div>
                <button className="btn" type="submit" disabled={asking || !q.trim()}>
                  {asking ? <span className="spin" /> : 'Ask'}
                </button>
              </div>
            </form>
            <div style={{ marginTop: 20 }}>
              {askError ? <div className="error">{askError}</div> : null}

              {askMode === 'data' && dataAnswer ? (
                dataAnswer.ok ? (
                  <>
                    <div className="answer">{dataAnswer.answer}</div>
                    <div className="hint" style={{ marginTop: 10 }}>
                      {dataAnswer.rowCount} row{dataAnswer.rowCount === 1 ? '' : 's'} · governed query, run as you
                    </div>
                    {dataAnswer.sql ? (
                      <details style={{ marginTop: 8 }}>
                        <summary className="hint" style={{ cursor: 'pointer', display: 'inline-block' }}>Show the SQL</summary>
                        <pre className="mono" style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, overflowX: 'auto', fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
                          {dataAnswer.sql}
                        </pre>
                      </details>
                    ) : null}
                    {dataAnswer.rows && dataAnswer.rows.length > 0 ? (
                      <div className="table-wrap" style={{ marginTop: 12 }}>
                        <table>
                          <thead>
                            <tr>{(dataAnswer.columns ?? []).map((c) => <th key={c}>{c}</th>)}</tr>
                          </thead>
                          <tbody>
                            {dataAnswer.rows.map((r, i) => (
                              <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {dataAnswer.traced ? <div className="hint" style={{ marginTop: 10 }}>✓ Traced in Langfuse — see Monitoring.</div> : null}
                  </>
                ) : (
                  <>
                    {/* Honest failure states — never a fabricated answer. */}
                    {dataAnswer.kind === 'no_dataset' ? (
                      <div className="answer">{dataAnswer.error}</div>
                    ) : (
                      <div className="error">
                        {dataAnswer.kind === 'invalid_sql'
                          ? `The generated SQL was rejected before execution — ${dataAnswer.error}.`
                          : `The query was refused — ${dataAnswer.error}`}
                      </div>
                    )}
                    {dataAnswer.sql ? (
                      <details style={{ marginTop: 8 }} open>
                        <summary className="hint" style={{ cursor: 'pointer', display: 'inline-block' }}>Show the SQL</summary>
                        <pre className="mono" style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, overflowX: 'auto', fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
                          {dataAnswer.sql}
                        </pre>
                      </details>
                    ) : null}
                  </>
                )
              ) : null}

              {askMode === 'docs' && answer ? (
                <>
                  <div className="answer">{answer.answer}</div>
                  {answer.retrieved.length > 0 ? (
                    <div className="sources">
                      {answer.retrieved.map((t, i) => <span className="chip" key={`${t}-${i}`}>{t}</span>)}
                    </div>
                  ) : null}
                  {answer.traced ? <div className="hint">✓ Traced in Langfuse — see Monitoring.</div> : null}
                </>
              ) : null}
            </div>
          </>
        ) : null}

        {view === 'query' ? (
          <>
            <div className="section-title">Query the lakehouse</div>
            {result && result.tables.length ? (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {result.tables.map((t) => (
                  <button key={t} type="button" className="chip" style={{ cursor: 'pointer', background: 'transparent' }}
                    onClick={() => preview(t)}>{t}</button>
                ))}
              </div>
            ) : null}
            <textarea
              className="mono"
              rows={6}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
              }}
              spellCheck={false}
            />
            <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
              <div className="hint" style={{ marginTop: 0 }}>⌘/Ctrl + Enter to run.</div>
              <button className="btn" onClick={() => run()} disabled={running || !sql.trim()}>
                {running ? <span className="spin" /> : 'Run query'}
              </button>
            </div>
            <div style={{ marginTop: 20 }}>
              {qError ? <div className="error">{qError}</div> : null}
              {result ? (
                <>
                  <div className="section-title">
                    {result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.engine}
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                      </thead>
                      <tbody>
                        {result.rows.map((r, i) => (
                          <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
