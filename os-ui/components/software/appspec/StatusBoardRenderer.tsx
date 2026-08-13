/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import type { StatusBoardConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `status-board` pattern: query the dataset, group rows into columns by `statusField`,
 * and render each row as a tile (kanban-style, READ-ONLY this phase — moving tiles is the future
 * `kanban-workflow` interactive pattern). Column mapping is BY NAME (robust to schema drift).
 * Honest states: loading → Spinner, error → Alert(error), no rows → Alert(info).
 *
 * Columns: when the author declares `columns:[{value,label}]`, those (in order) are the board's
 * columns and their labels; rows whose status isn't among them fall into a trailing "Other"
 * column so nothing is silently dropped. When no columns are declared, they're derived from the
 * distinct status values present (sorted) — honest to the live data.
 */
export function StatusBoardRenderer({ view, os }: { view: StatusBoardConfig; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({
    status: 'loading',
  });

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

  // Resolve the field indices we render BY NAME.
  const idx = useMemo(() => {
    const cols = state.result?.columns ?? [];
    return {
      status: cols.indexOf(view.statusField),
      title: cols.indexOf(view.titleField),
      subtitles: (view.subtitleFields ?? []).map((f) => ({ field: f, index: cols.indexOf(f) })),
    };
  }, [state.result, view.statusField, view.titleField, view.subtitleFields]);

  // Build the ordered columns (declared, else derived) and bucket rows into them.
  const board = useMemo(() => {
    const rows = state.result?.rows ?? [];
    const at = (row: string[], i: number) => (i >= 0 ? row[i] ?? '' : '');

    let cols: { value: string; label: string }[];
    if (view.columns && view.columns.length > 0) {
      cols = [...view.columns];
    } else {
      const seen = new Set<string>();
      for (const r of rows) {
        const v = at(r, idx.status);
        seen.add(v === '' ? '—' : v);
      }
      cols = Array.from(seen)
        .sort()
        .map((v) => ({ value: v, label: v }));
    }

    const buckets = new Map<string, string[][]>();
    for (const c of cols) buckets.set(c.value, []);
    const OTHER = '__other__';
    let hasOther = false;
    for (const r of rows) {
      const raw = at(r, idx.status);
      const key = raw === '' ? '—' : raw;
      if (buckets.has(key)) buckets.get(key)!.push(r);
      else {
        if (!buckets.has(OTHER)) buckets.set(OTHER, []);
        buckets.get(OTHER)!.push(r);
        hasOther = true;
      }
    }

    const ordered = cols.map((c) => ({ ...c, rows: buckets.get(c.value) ?? [] }));
    if (hasOther) ordered.push({ value: OTHER, label: 'Other', rows: buckets.get(OTHER) ?? [] });
    return { columns: ordered, at };
  }, [state.result, view.columns, idx]);

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return <Alert variant="error">Could not load this board: {state.error}</Alert>;
  }
  if (idx.status < 0) {
    return <Alert variant="error">Status field “{view.statusField}” is not in this dataset.</Alert>;
  }
  if ((state.result?.rows.length ?? 0) === 0) {
    return <Alert variant="info">No records to show.</Alert>;
  }

  return (
    <div
      style={{
        display: 'grid',
        gridAutoFlow: 'column',
        gridAutoColumns: 'minmax(240px, 1fr)',
        gap: 16,
        overflowX: 'auto',
        paddingBottom: 4,
      }}
    >
      {board.columns.map((col) => (
        <section key={col.value} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              paddingBottom: 6,
              borderBottom: '1px solid var(--sb-border)',
            }}
          >
            <span
              className="sb-mono"
              style={{
                fontFamily: 'var(--sb-font-head)',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '1.2px',
                color: 'var(--sb-gold-text)',
              }}
            >
              {col.label}
            </span>
            <Badge tone="muted">{col.rows.length}</Badge>
          </header>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {col.rows.length === 0 ? (
              <span style={{ color: 'var(--sb-text-faint)', fontSize: 12, padding: '6px 2px' }}>Empty</span>
            ) : (
              col.rows.map((row, i) => (
                <article key={i} className="sb-card" style={{ padding: 14 }}>
                  <div style={{ fontFamily: 'var(--sb-font-head)', fontSize: 14, fontWeight: 600, color: 'var(--sb-text)' }}>
                    {board.at(row, idx.title) || '—'}
                  </div>
                  {idx.subtitles.length > 0 && (
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {idx.subtitles.map((s) => {
                        const v = board.at(row, s.index);
                        if (!v) return null;
                        return (
                          <div key={s.field} style={{ color: 'var(--sb-text-muted)', fontSize: 12.5 }}>
                            {v}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
