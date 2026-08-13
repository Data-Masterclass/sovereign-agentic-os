/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Input, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import { formatCell, resolveColumns } from '@/lib/software/appspec/render-logic.ts';
import type { MasterDetailConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `master-detail` pattern: a governed dataset queried once, then a scrollable LIST on
 * the left (rows keyed by `keyField`, filterable by a quick search over the list columns) and the
 * SELECTED record's `detailFields` on the right as a label/value sheet. Reuses the same pure
 * column-mapping/formatting the table + detail patterns use (BY NAME, robust to schema drift).
 * Honest states: loading → Spinner, error → Alert(error), no rows → Alert(info).
 */
export function MasterDetailRenderer({ view, os }: { view: MasterDetailConfig; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({
    status: 'loading',
  });
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    os.datasets
      .query(view.source.datasetId, { limit: 1000 })
      .then((result) => {
        if (alive) setState({ status: 'ready', result });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [os, view.source.datasetId]);

  const keyIndex = useMemo(
    () => (state.result ? state.result.columns.indexOf(view.keyField) : -1),
    [state.result, view.keyField],
  );
  const listCols = useMemo(
    () => (state.result ? resolveColumns(state.result.columns, view.listColumns) : []),
    [state.result, view.listColumns],
  );
  const detailCols = useMemo(
    () => (state.result ? resolveColumns(state.result.columns, view.detailFields) : []),
    [state.result, view.detailFields],
  );

  const rows = state.result?.rows ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => listCols.some((c) => (c.index >= 0 ? row[c.index] ?? '' : '').toLowerCase().includes(needle)));
  }, [rows, listCols, q]);

  const keyOf = (row: string[]) => (keyIndex >= 0 ? row[keyIndex] ?? '' : '');
  const activeKey = selectedKey || (filtered[0] ? keyOf(filtered[0]) : '');
  const selectedRow = useMemo(
    () => rows.find((r) => keyOf(r) === activeKey),
    [rows, activeKey, keyIndex],
  );

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') return <Alert variant="error">Could not load this view: {state.error}</Alert>;
  if (keyIndex < 0) return <Alert variant="error">Key field “{view.keyField}” is not in this dataset.</Alert>;
  if (rows.length === 0) return <Alert variant="info">No records to show.</Alert>;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(220px, 340px) 1fr',
        gap: 20,
        alignItems: 'start',
      }}
    >
      {/* Master list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div
          role="listbox"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            maxHeight: 460,
            overflowY: 'auto',
            paddingRight: 2,
          }}
        >
          {filtered.length === 0 ? (
            <span style={{ color: 'var(--sb-text-faint)', fontSize: 13, padding: '6px 2px' }}>No matches.</span>
          ) : (
            filtered.map((row, i) => {
              const k = keyOf(row);
              const active = k === activeKey;
              const primary = listCols[0];
              const secondary = listCols[1];
              return (
                <button
                  key={`${k}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => setSelectedKey(k)}
                  style={{
                    textAlign: 'left',
                    padding: '9px 12px',
                    borderRadius: 'var(--sb-radius)',
                    border: '1px solid',
                    borderColor: active ? 'var(--sb-gold-line)' : 'transparent',
                    background: active ? 'var(--sb-gold-soft)' : 'transparent',
                    cursor: 'pointer',
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--sb-font-head)',
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: active ? 'var(--sb-gold-text)' : 'var(--sb-text)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {primary && primary.index >= 0 ? formatCell(row[primary.index] ?? '', primary.format) : k || '—'}
                  </div>
                  {secondary && secondary.index >= 0 && (
                    <div style={{ fontSize: 12, color: 'var(--sb-text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {formatCell(row[secondary.index] ?? '', secondary.format)}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Detail sheet */}
      <div className="sb-card" style={{ padding: 20, minWidth: 0 }}>
        {selectedRow ? (
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '10px 20px', margin: 0 }}>
            {detailCols.map((c) => {
              const raw = c.index >= 0 ? selectedRow[c.index] ?? '' : '';
              const text = c.index < 0 ? '—' : formatCell(raw, c.format);
              return (
                <div key={c.field} style={{ display: 'contents' }}>
                  <dt style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--sb-text-muted)' }}>{c.label}</dt>
                  <dd style={{ margin: 0, color: 'var(--sb-text)' }}>
                    {c.format === 'badge' && c.index >= 0 ? <Badge>{text}</Badge> : text}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <span style={{ color: 'var(--sb-text-faint)' }}>Select a record to see its details.</span>
        )}
      </div>
    </div>
  );
}
