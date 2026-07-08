/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import DataTab from '@/components/data/DataTab';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';
import { useTabNavReset } from '@/lib/tab-nav';

type QueryResult = {
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

const DEFAULT_SQL =
  'select order_date, revenue, orders\nfrom daily_revenue\norder by order_date';

// The Data tab is TWO surfaces: Datasets (the unified, Files-style home — All Data ·
// My Data · Shared Data · Marketplace Data, with catalog detail folded into each
// dataset) and Query (the power-user SQL editor). Conversational data Q&A lives in
// the global Ask-the-OS assistant, not here; the engine (Trino/Iceberg) is invisible.
type View = 'datasets' | 'query';

export default function DataPage() {
  const [view, setView] = useState<View>('datasets');

  // Clicking the Data sidebar link returns to the primary Datasets sub-tab (its
  // list). DataTab separately resets any open dataset detail back to the tiles.
  useTabNavReset(() => setView('datasets'));

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
      <PageHeader title="Data" crumb="datasets · query" tutorial="data" />
      <div className="content">
        <div className="tabstrip">
          <button className={view === 'datasets' ? 'active' : ''} onClick={() => setView('datasets')} {...anchorAttr(ANCHORS.data.sandbox)}>Datasets</button>
          <button className={view === 'query' ? 'active' : ''} onClick={() => setView('query')} {...anchorAttr(ANCHORS.data.query)}>Query</button>
        </div>

        {view === 'datasets' ? <DataTab /> : null}

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
