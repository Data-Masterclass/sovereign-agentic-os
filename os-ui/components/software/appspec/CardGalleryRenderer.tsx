/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Input, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import { formatCell, resolveColumns } from '@/lib/software/appspec/render-logic.ts';
import type { CardGalleryConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `card-gallery` pattern: query the dataset once and lay its records out as a
 * responsive grid of cards — a title (`titleField`), an optional subtitle, and any extra `fields`
 * as label/value lines. Optional client-side search filters over the title/subtitle/fields.
 * Column mapping is BY NAME (robust to schema drift). Honest states: loading → Spinner, error →
 * Alert(error), no rows → Alert(info).
 */
export function CardGalleryRenderer({ view, os }: { view: CardGalleryConfig; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({
    status: 'loading',
  });
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

  const idx = useMemo(() => {
    const cols = state.result?.columns ?? [];
    return {
      title: cols.indexOf(view.titleField),
      subtitle: view.subtitleField ? cols.indexOf(view.subtitleField) : -1,
    };
  }, [state.result, view.titleField, view.subtitleField]);

  const fieldCols = useMemo(
    () => (state.result ? resolveColumns(state.result.columns, view.fields ?? []) : []),
    [state.result, view.fields],
  );

  const rows = state.result?.rows ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    const cellIdxs = [idx.title, idx.subtitle, ...fieldCols.map((c) => c.index)].filter((i) => i >= 0);
    return rows.filter((row) => cellIdxs.some((i) => (row[i] ?? '').toLowerCase().includes(needle)));
  }, [rows, q, idx, fieldCols]);

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') return <Alert variant="error">Could not load this gallery: {state.error}</Alert>;
  if (idx.title < 0) return <Alert variant="error">Title field “{view.titleField}” is not in this dataset.</Alert>;
  if (rows.length === 0) return <Alert variant="info">No records to show.</Alert>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {view.search && (
        <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      )}
      {filtered.length === 0 ? (
        <Alert variant="info">No cards match.</Alert>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
          {filtered.map((row, i) => (
            <article key={i} className="sb-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--sb-font-head)', fontSize: 16, fontWeight: 600, color: 'var(--sb-text)' }}>
                {(idx.title >= 0 ? row[idx.title] : '') || '—'}
              </div>
              {idx.subtitle >= 0 && (row[idx.subtitle] ?? '') !== '' && (
                <div style={{ fontSize: 13, color: 'var(--sb-text-muted)' }}>{row[idx.subtitle]}</div>
              )}
              {fieldCols.length > 0 && (
                <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: '4px 0 0' }}>
                  {fieldCols.map((c) => {
                    const raw = c.index >= 0 ? row[c.index] ?? '' : '';
                    const text = c.index < 0 ? '—' : formatCell(raw, c.format);
                    return (
                      <div key={c.field} style={{ display: 'contents' }}>
                        <dt style={{ fontSize: 11.5, color: 'var(--sb-text-faint)' }}>{c.label}</dt>
                        <dd style={{ margin: 0, fontSize: 12.5, color: 'var(--sb-text)' }}>
                          {c.format === 'badge' && c.index >= 0 ? <Badge>{text}</Badge> : text}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
