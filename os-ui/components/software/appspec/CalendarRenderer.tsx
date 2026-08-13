/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Spinner } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import type { CalendarConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `calendar` pattern: query the dataset and place each record on a light MONTH grid by
 * its `dateField`, labelled by `titleField`. No heavy calendar lib — a plain 7-column grid built
 * from the visible month; the viewer pages months with ‹/›. Records default to the newest month
 * that has any. Records with an unparseable/blank date are surfaced in a small "no date" list so
 * nothing is silently dropped. Honest states: loading → Spinner, error → Alert(error), no rows →
 * Alert(info).
 */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A record placed on a day: the local date key (yyyy-mm-dd) + its title. */
type Placed = { y: number; m: number; d: number; title: string };

export function CalendarRenderer({ view, os }: { view: CalendarConfig; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({
    status: 'loading',
  });
  // The visible month as {year, month0} — null until we've seen the data (then latest-with-records).
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null);

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
    return { date: cols.indexOf(view.dateField), title: cols.indexOf(view.titleField) };
  }, [state.result, view.dateField, view.titleField]);

  const { placed, undated } = useMemo(() => {
    const rows = state.result?.rows ?? [];
    const placed: Placed[] = [];
    const undated: string[] = [];
    for (const row of rows) {
      const title = idx.title >= 0 ? row[idx.title] ?? '' : '';
      const raw = idx.date >= 0 ? row[idx.date] ?? '' : '';
      const t = Date.parse(raw);
      if (Number.isNaN(t)) {
        undated.push(title || '—');
        continue;
      }
      const dt = new Date(t);
      placed.push({ y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), title: title || '—' });
    }
    return { placed, undated };
  }, [state.result, idx]);

  // Default the visible month to the newest month that has a record.
  const latest = useMemo(() => {
    let best: { y: number; m: number } | null = null;
    for (const p of placed) {
      if (!best || p.y > best.y || (p.y === best.y && p.m > best.m)) best = { y: p.y, m: p.m };
    }
    return best;
  }, [placed]);

  const visible = month ?? latest ?? { y: new Date().getUTCFullYear(), m: new Date().getUTCMonth() };

  // Records for the visible month, bucketed by day-of-month.
  const byDay = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const p of placed) {
      if (p.y === visible.y && p.m === visible.m) {
        if (!map.has(p.d)) map.set(p.d, []);
        map.get(p.d)!.push(p.title);
      }
    }
    return map;
  }, [placed, visible.y, visible.m]);

  // The grid cells: leading blanks (Mon-first) + each day of the month.
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(visible.y, visible.m, 1));
    const lead = (first.getUTCDay() + 6) % 7; // 0=Mon
    const daysInMonth = new Date(Date.UTC(visible.y, visible.m + 1, 0)).getUTCDate();
    const out: (number | null)[] = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(d);
    return out;
  }, [visible.y, visible.m]);

  function shift(delta: number) {
    const base = month ?? visible;
    const d = new Date(Date.UTC(base.y, base.m + delta, 1));
    setMonth({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
  }

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') return <Alert variant="error">Could not load this calendar: {state.error}</Alert>;
  if (idx.date < 0) return <Alert variant="error">Date field “{view.dateField}” is not in this dataset.</Alert>;
  if ((state.result?.rows.length ?? 0) === 0) return <Alert variant="info">No records to show.</Alert>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="sb-btn sb-ghost sb-sm" onClick={() => shift(-1)}>
          ‹
        </button>
        <div style={{ fontFamily: 'var(--sb-font-head)', fontSize: 16, fontWeight: 600, minWidth: 120, textAlign: 'center' }}>
          {MONTHS[visible.m]} {visible.y}
        </div>
        <button type="button" className="sb-btn sb-ghost sb-sm" onClick={() => shift(1)}>
          ›
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--sb-text-faint)', textAlign: 'center', paddingBottom: 2 }}>
            {w}
          </div>
        ))}
        {cells.map((d, i) => {
          const events = d != null ? byDay.get(d) ?? [] : [];
          return (
            <div
              key={i}
              style={{
                minHeight: 84,
                borderRadius: 'var(--sb-radius)',
                border: '1px solid var(--sb-border)',
                background: d == null ? 'transparent' : 'var(--sb-bg-elevated)',
                padding: d == null ? 0 : 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                minWidth: 0,
              }}
            >
              {d != null && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, color: events.length ? 'var(--sb-text)' : 'var(--sb-text-faint)' }}>{d}</div>
                  {events.slice(0, 3).map((title, j) => (
                    <div
                      key={j}
                      title={title}
                      style={{
                        fontSize: 11,
                        padding: '2px 6px',
                        borderRadius: 6,
                        background: 'var(--sb-gold-soft)',
                        color: 'var(--sb-gold-text)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {title}
                    </div>
                  ))}
                  {events.length > 3 && <div style={{ fontSize: 10.5, color: 'var(--sb-text-faint)' }}>+{events.length - 3} more</div>}
                </>
              )}
            </div>
          );
        })}
      </div>

      {undated.length > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--sb-text-muted)' }}>
          {undated.length} record{undated.length === 1 ? '' : 's'} without a readable date are not shown on the grid.
        </div>
      )}
    </div>
  );
}
