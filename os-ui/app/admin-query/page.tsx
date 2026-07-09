/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * Admin Query console — dual-engine (Lakehouse SQL + Cube semantic layer).
 *
 * Access: admin-only. The tab itself is minRole:admin in the sidebar (lib/tabs.ts),
 * and the underlying /api/admin-query route enforces the same gate server-side
 * (fail-closed: 403 for non-admins even if they reach the URL directly).
 *
 * The admin principal runs as their own governed identity — broad visibility via
 * Trino OPA + Cube RLS — NOT a policy bypass. Every read still flows through the
 * governed query-tool and cubeLoad paths in lib/governed.ts.
 */

import { useCallback, useState } from 'react';
import PageHeader from '@/components/PageHeader';

// ---- Types ------------------------------------------------------------------

type Mode = 'lakehouse' | 'cube';

type LakehouseResult = {
  mode: 'lakehouse';
  engine: string;
  tables: string[];
  columns: string[];
  rows: string[][];
  rowCount: number;
};

type CubeResult = {
  mode: 'cube';
  rows: Record<string, unknown>[];
  annotation: Record<string, unknown>;
};

type QueryResult = LakehouseResult | CubeResult;

// ---- Defaults ---------------------------------------------------------------

const DEFAULT_SQL = 'SELECT current_catalog, current_schema';

const DEFAULT_CUBE_JSON = JSON.stringify(
  {
    measures: ['Orders.revenue'],
    dimensions: [],
    limit: 10,
  },
  null,
  2,
);

// ---- Component --------------------------------------------------------------

export default function AdminQueryPage() {
  const [mode, setMode] = useState<Mode>('lakehouse');

  // Lakehouse state
  const [sql, setSql] = useState(DEFAULT_SQL);

  // Cube state
  const [cubeJson, setCubeJson] = useState(DEFAULT_CUBE_JSON);
  const [cubeJsonError, setCubeJsonError] = useState('');

  // Shared run state
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [runError, setRunError] = useState('');

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setRunError('');
    setResult(null);

    let body: Record<string, unknown>;

    if (mode === 'lakehouse') {
      const text = sql.trim();
      if (!text) { setRunning(false); return; }
      body = { mode: 'lakehouse', sql: text };
    } else {
      // Validate Cube JSON before sending
      let parsed: unknown;
      try {
        parsed = JSON.parse(cubeJson);
      } catch (err) {
        setCubeJsonError(`Invalid JSON: ${(err as Error).message}`);
        setRunning(false);
        return;
      }
      setCubeJsonError('');
      body = { mode: 'cube', query: parsed };
    }

    try {
      const res = await fetch('/api/admin-query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setRunError(data.error ?? `Request failed (${res.status})`);
      else setResult(data as QueryResult);
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [mode, sql, cubeJson, running]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        run();
      }
    },
    [run],
  );

  // Derive columns for the result table
  const columns: string[] = result
    ? result.mode === 'lakehouse'
      ? (result as LakehouseResult).columns
      : result.rows.length > 0
        ? Object.keys(result.rows[0])
        : []
    : [];

  const rows: unknown[][] = result
    ? result.mode === 'lakehouse'
      ? (result as LakehouseResult).rows
      : result.rows.map((r) => columns.map((c) => r[c]))
    : [];

  const rowCount = result ? rows.length : 0;

  const engine =
    result?.mode === 'lakehouse'
      ? (result as LakehouseResult).engine ?? 'trino'
      : 'cube';

  return (
    <>
      <PageHeader
        title="Query"
        crumb="admin console — lakehouse SQL + cube semantic layer"
      />
      <div className="content">
        {/* Mode selector */}
        <div className="row" style={{ gap: 8, marginBottom: 24 }}>
          <button
            type="button"
            className={mode === 'lakehouse' ? 'btn' : 'btn btn-ghost'}
            onClick={() => { setMode('lakehouse'); setResult(null); setRunError(''); }}
          >
            Lakehouse SQL
          </button>
          <button
            type="button"
            className={mode === 'cube' ? 'btn' : 'btn btn-ghost'}
            onClick={() => { setMode('cube'); setResult(null); setRunError(''); }}
          >
            Cube (semantic layer)
          </button>
        </div>

        {/* Editor */}
        <div className="query-section">
          {mode === 'lakehouse' ? (
            <>
              <div className="section-title">SQL — Trino / Iceberg</div>
              <div className="hint" style={{ marginBottom: 8 }}>
                Runs as your admin principal through the governed query-tool (OPA row/column
                policy applies — this is not a bypass).
              </div>
              <textarea
                className="mono"
                rows={8}
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                placeholder="SELECT ..."
              />
            </>
          ) : (
            <>
              <div className="section-title">Cube query JSON</div>
              <div className="hint" style={{ marginBottom: 8 }}>
                Paste a Cube.js query object (measures, dimensions, filters, …). Proxied via{' '}
                <code>cubeLoad</code> in lib/governed.ts — OPA authz + Langfuse trace apply.
              </div>
              <textarea
                className="mono"
                rows={10}
                value={cubeJson}
                onChange={(e) => { setCubeJson(e.target.value); setCubeJsonError(''); }}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                placeholder='{ "measures": ["..."], "dimensions": [] }'
              />
              {cubeJsonError ? (
                <div className="error" style={{ marginTop: 6 }}>{cubeJsonError}</div>
              ) : null}
            </>
          )}

          <div className="row" style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="hint" style={{ marginTop: 0 }}>⌘ / Ctrl + Enter to run.</div>
            <button
              className="btn"
              onClick={run}
              disabled={running || (mode === 'lakehouse' ? !sql.trim() : !cubeJson.trim())}
            >
              {running ? <span className="spin" /> : 'Run'}
            </button>
          </div>
        </div>

        {/* Results */}
        <div style={{ marginTop: 24 }}>
          {runError ? (
            <div className="error">{runError}</div>
          ) : result ? (
            <>
              <div className="section-title">
                {rowCount} row{rowCount === 1 ? '' : 's'} · {engine}
              </div>
              {columns.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          {r.map((cell, j) => (
                            <td key={j}>
                              {cell === null || cell === undefined
                                ? <span className="muted">—</span>
                                : typeof cell === 'object'
                                  ? JSON.stringify(cell)
                                  : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="muted">No rows returned.</div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
