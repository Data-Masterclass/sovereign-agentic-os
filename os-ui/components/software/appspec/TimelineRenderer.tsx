/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import { formatCell } from '@/lib/software/appspec/render-logic.ts';
import type { TimelineConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `timeline` pattern: query the dataset, order records by `dateField` NEWEST FIRST, and
 * render them down a vertical time axis (a node + connector rail), each with its date, `titleField`
 * and optional `descriptionField`. Unparseable/blank dates sort last (kept, not dropped — honest).
 * Column mapping is BY NAME. Honest states: loading → Spinner, error → Alert(error), no rows →
 * Alert(info).
 */
export function TimelineRenderer({ view, os }: { view: TimelineConfig; os: OsClient }) {
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

  const idx = useMemo(() => {
    const cols = state.result?.columns ?? [];
    return {
      date: cols.indexOf(view.dateField),
      title: cols.indexOf(view.titleField),
      description: view.descriptionField ? cols.indexOf(view.descriptionField) : -1,
    };
  }, [state.result, view.dateField, view.titleField, view.descriptionField]);

  const ordered = useMemo(() => {
    const rows = state.result?.rows ?? [];
    if (idx.date < 0) return rows.map((row, i) => ({ row, i }));
    const withTime = rows.map((row, i) => {
      const t = Date.parse(row[idx.date] ?? '');
      return { row, i, t: Number.isNaN(t) ? -Infinity : t };
    });
    // Newest first; unparseable/blank (-Infinity) sink to the bottom, stably.
    return withTime.sort((a, b) => b.t - a.t);
  }, [state.result, idx.date]);

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') return <Alert variant="error">Could not load this timeline: {state.error}</Alert>;
  if (idx.date < 0) return <Alert variant="error">Date field “{view.dateField}” is not in this dataset.</Alert>;
  if ((state.result?.rows.length ?? 0) === 0) return <Alert variant="info">No records to show.</Alert>;

  return (
    <div style={{ position: 'relative', paddingLeft: 28 }}>
      {/* The vertical rail. */}
      <div
        aria-hidden
        style={{ position: 'absolute', left: 7, top: 8, bottom: 8, width: 2, background: 'var(--sb-border)' }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {ordered.map(({ row, i }) => {
          const dateRaw = idx.date >= 0 ? row[idx.date] ?? '' : '';
          const date = formatCell(dateRaw, 'date');
          const title = idx.title >= 0 ? row[idx.title] ?? '' : '';
          const desc = idx.description >= 0 ? row[idx.description] ?? '' : '';
          return (
            <div key={i} style={{ position: 'relative' }}>
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: -28,
                  top: 4,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: 'var(--sb-bg)',
                  border: '2px solid var(--sb-gold)',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--sb-gold-text)', fontFamily: 'var(--sb-font-head)' }}>
                {date || '—'}
              </div>
              <div style={{ fontFamily: 'var(--sb-font-head)', fontSize: 15.5, fontWeight: 600, color: 'var(--sb-text)', marginTop: 2 }}>
                {title || '—'}
              </div>
              {desc !== '' && <div style={{ fontSize: 13.5, color: 'var(--sb-text-muted)', marginTop: 4, lineHeight: 1.5 }}>{desc}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
