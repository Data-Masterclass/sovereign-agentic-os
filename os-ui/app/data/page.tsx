/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import ArtifactPanel from '@/components/ArtifactPanel';
import NewDataProduct from '@/components/NewDataProduct';
import SandboxLane from '@/components/SandboxLane';

type QueryResult = {
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};
type Asset = { name: string; fqn: string; description: string; type: string };
type Catalog = { source: string; note?: string; assets: Asset[] };
type Answer = { question: string; answer: string; retrieved: string[]; traced: boolean };

const DEFAULT_SQL =
  'select order_date, revenue, orders\nfrom daily_revenue\norder by order_date';
const ASK_EXAMPLES = [
  'What provides the retrieval backbone for vector and lexical search?',
  'How does the platform stay sovereign?',
  'What gives observability and tracing?',
];

type View = 'new' | 'mydata' | 'datasets' | 'transform' | 'catalog' | 'ask' | 'products' | 'query';

export default function DataPage() {
  const [view, setView] = useState<View>('new');

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

  // ---- talk to your data (sample-agent RAG) ----
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [askError, setAskError] = useState('');
  const ask = useCallback(
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
  function preview(fqn: string) {
    const bare = fqn.includes('.') ? fqn.split('.').pop()! : fqn;
    setView('query');
    run(`select * from ${bare} limit 50`);
  }

  // ---- data products ----
  const [product, setProduct] = useState<string>('');

  return (
    <>
      <PageHeader title="Data" crumb="catalog · talk to your data · data products · query" />
      <div className="content">
        <p className="lead">
          All structured data in the platform: browse the catalog, talk to your data, define
          data products with dbt transformations, and query the lakehouse directly.
        </p>

        <div className="tabstrip">
          <button className={view === 'new' ? 'active' : ''} onClick={() => setView('new')}>+ New data product</button>
          <button className={view === 'mydata' ? 'active' : ''} onClick={() => setView('mydata')}>My data</button>
          <button className={view === 'datasets' ? 'active' : ''} onClick={() => setView('datasets')}>Datasets</button>
          <button className={view === 'transform' ? 'active' : ''} onClick={() => setView('transform')}>Transform (dbt)</button>
          <button className={view === 'catalog' ? 'active' : ''} onClick={() => setView('catalog')}>Catalog</button>
          <button className={view === 'ask' ? 'active' : ''} onClick={() => setView('ask')}>Talk to your data</button>
          <button className={view === 'products' ? 'active' : ''} onClick={() => setView('products')}>Data products</button>
          <button className={view === 'query' ? 'active' : ''} onClick={() => setView('query')}>Query</button>
        </div>

        {view === 'new' ? <NewDataProduct onDone={() => setView('datasets')} /> : null}

        {view === 'mydata' ? <SandboxLane /> : null}

        {view === 'datasets' ? (
          <ArtifactPanel
            type="dataset"
            createLabel="Load dataset"
            specFields={[{ key: 'table', label: 'Source table / file', placeholder: 'raw_orders' }]}
            renderSpec={(a) => (a.spec?.table ? <div className="muted mono" style={{ fontSize: 11 }}>table: {String(a.spec.table)}</div> : null)}
            intro={
              <p className="hint" style={{ marginTop: 0 }}>
                Load data as a dataset artifact (Personal). Document it, then a builder promotes it to
                Shared and an admin certifies it to the Marketplace. The full upload pipeline is
                <strong> scaffolded in v1</strong> — the artifact captures the dataset metadata.
              </p>
            }
          />
        ) : null}

        {view === 'transform' ? (
          <ArtifactPanel
            type="transformation"
            createLabel="Create dbt model"
            specFields={[
              { key: 'sql', label: 'dbt model SQL', textarea: true, mono: true, placeholder: 'select day, sum(amount) as revenue\nfrom {{ ref("stg_orders") }}\ngroup by 1' },
              { key: 'materialization', label: 'Materialization', placeholder: 'table | view | incremental' },
            ]}
            renderSpec={(a) => (a.spec?.sql ? <pre className="codeblock" style={{ marginTop: 8 }}>{String(a.spec.sql)}</pre> : null)}
            intro={
              <p className="hint" style={{ marginTop: 0 }}>
                Author a dbt-core transformation as an artifact. Running it against the dbt backend
                (Dagster-materialized) is <strong>scaffolded in v1</strong>; the model SQL + grain are
                captured for review, promotion, and reuse.
              </p>
            }
          />
        ) : null}

        {view === 'catalog' ? (
          <>
            <div className="section-title">
              Structured data assets
              {catalog ? (
                <span className="count-pill ok">via {catalog.source}</span>
              ) : null}
            </div>
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
                        <th>Fully-qualified name</th>
                        <th>Description</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {catalog.assets.map((a) => (
                        <tr key={a.fqn}>
                          <td style={{ fontWeight: 600 }}>{a.name}</td>
                          <td>{a.type}</td>
                          <td className="mono">{a.fqn}</td>
                          <td className="muted" style={{ whiteSpace: 'normal' }}>{a.description || '—'}</td>
                          <td>
                            <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => preview(a.fqn)}>
                              Preview →
                            </button>
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
            <div className="section-title">Talk to your data</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Ask the domain RAG agent (sample-agent on LangGraph). It retrieves from your
              knowledge (OpenSearch), generates via LiteLLM, and traces in Langfuse.
            </p>
            <form onSubmit={(e) => { e.preventDefault(); ask(q); }}>
              <textarea
                rows={3}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Ask a question about your data and documents…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(q); }
                }}
              />
              <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {ASK_EXAMPLES.map((ex) => (
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
              {answer ? (
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

        {view === 'products' ? (
          <>
            <div className="section-title">Data products</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              A data product packages tables, transformations, and quality rules at a chosen
              visibility. Pick a base table, then the per-product agent helps define the dbt
              model. Publishing a data product is <strong>scaffolded in v1</strong> — the agent
              produces the dbt model + tests as a draft to review.
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {(catalog?.assets ?? []).map((a) => (
                <button key={a.fqn} type="button"
                  className={`chip${product === a.name ? '' : ''}`}
                  style={{ cursor: 'pointer', background: product === a.name ? undefined : 'transparent' }}
                  onClick={() => setProduct(a.name)}>
                  {a.name}
                </button>
              ))}
              {(!catalog || catalog.assets.length === 0) ? (
                <span className="hint" style={{ marginTop: 0 }}>No base tables in the catalog yet.</span>
              ) : null}
            </div>
            <AgentChat
              key={product || 'data-product'}
              agent="data-product"
              label="data product agent"
              placeholder={
                product
                  ? `Define a dbt transformation for the "${product}" data product…`
                  : 'Pick a base table above, then describe the transformation you want…'
              }
              starters={
                product
                  ? [
                      `Create a staging model that cleans ${product}.`,
                      `Build a daily aggregate mart from ${product} with dbt tests.`,
                    ]
                  : ['What is a data product and how do I define one?']
              }
            />
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
