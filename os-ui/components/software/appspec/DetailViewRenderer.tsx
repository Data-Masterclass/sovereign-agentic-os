/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Select, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import { formatCell, resolveColumns } from '@/lib/software/appspec/render-logic.ts';
import type { DetailConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `detail` pattern: query the dataset, let the viewer pick ONE row by its `keyField`
 * (a simple Select), and show the chosen row's `fields` as label/value pairs with the pure
 * `formatCell`. Column mapping is BY NAME (robust to schema drift). Honest states: loading →
 * Spinner, error → Alert(error), no rows → Alert(info). `view` is the pattern's `DetailConfig`.
 */
export function DetailViewRenderer({ view, os }: { view: DetailConfig; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({
    status: 'loading',
  });
  const [selectedKey, setSelectedKey] = useState<string>('');

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

  // Resolve the key column + the field columns together (all BY NAME).
  const keyIndex = useMemo(
    () => (state.result ? state.result.columns.indexOf(view.keyField) : -1),
    [state.result, view.keyField],
  );
  const fieldCols = useMemo(
    () => (state.result ? resolveColumns(state.result.columns, view.fields) : []),
    [state.result, view.fields],
  );

  const keys = useMemo(() => {
    if (!state.result || keyIndex < 0) return [];
    return state.result.rows.map((r) => r[keyIndex] ?? '');
  }, [state.result, keyIndex]);

  const activeKey = selectedKey || keys[0] || '';
  const row = useMemo(() => {
    if (!state.result || keyIndex < 0) return undefined;
    return state.result.rows.find((r) => (r[keyIndex] ?? '') === activeKey);
  }, [state.result, keyIndex, activeKey]);

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return <Alert variant="error">Could not load this record: {state.error}</Alert>;
  }
  if (keyIndex < 0) {
    return <Alert variant="error">Key field “{view.keyField}” is not in this dataset.</Alert>;
  }
  if (keys.length === 0) {
    return <Alert variant="info">No records to show.</Alert>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <span>{view.keyField}</span>
        <Select value={activeKey} onChange={(e) => setSelectedKey(e.target.value)}>
          {keys.map((k, i) => (
            <option key={`${k}-${i}`} value={k}>
              {k || '—'}
            </option>
          ))}
        </Select>
      </label>

      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', margin: 0 }}>
        {fieldCols.map((c) => {
          const raw = row && c.index >= 0 ? row[c.index] ?? '' : '';
          const text = c.index < 0 ? '—' : formatCell(raw, c.format);
          return (
            <div key={c.field} style={{ display: 'contents' }}>
              <dt style={{ fontWeight: 600, opacity: 0.75 }}>{c.label}</dt>
              <dd style={{ margin: 0 }}>{c.format === 'badge' && c.index >= 0 ? <Badge>{text}</Badge> : text}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
