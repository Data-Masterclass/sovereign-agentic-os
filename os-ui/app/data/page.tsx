/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import DataTab from '@/components/data/DataTab';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';

type QueryResult = {
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

const DEFAULT_SQL =
  'select order_date, revenue, orders\nfrom daily_revenue\norder by order_date';

// The Data tab is ONE screen, in one scroll: the datasets home on top (the unified,
// Files-style grid — All · My · Shared · Marketplace, with catalog detail folded into
// each dataset), and the power-user SQL editor at the bottom. Conversational data Q&A
// lives in the global Ask-the-OS assistant; the engine (Trino/Iceberg) stays invisible.

export default function DataPage() {
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
    run(`select * from ${bare} limit 50`);
  }, [run]);

  return (
    <>
      <PageHeader title="Data" crumb="datasets · query" tutorial="data" />
      <div className="content">
        {/* Top: the datasets home (tiles → detail → build flow). */}
        <div {...anchorAttr(ANCHORS.data.sandbox)}>
          <DataTab />
        </div>

        {/* Bottom: the power-user SQL editor — one screen, one scroll, below the tiles.
            Same governed /api/query path; only the placement changed. */}
        <div className="query-section" style={{ marginTop: 40 }} {...anchorAttr(ANCHORS.data.query)}>
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
        </div>
      </div>
    </>
  );
}
