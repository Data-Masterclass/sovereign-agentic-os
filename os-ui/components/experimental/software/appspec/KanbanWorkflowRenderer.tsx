/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient } from '@/lib/app-sdk/index.ts';
import type { KanbanWorkflowConfig } from '@/lib/experimental/software/appspec/patterns.ts';
import { reduceByKey, recordsFromList, type AppendedRecord } from '@/lib/experimental/software/appspec/records-reduce.ts';
import { isRealSave } from '@/lib/experimental/software/appspec/interactive-logic.ts';

/**
 * Render the `kanban-workflow` pattern: columns from `view.columns`, cards = reduced records
 * grouped by `view.statusField`. Moving a card via ‹ › buttons calls `os.records.update`
 * to write the new status (append-only supersede). The list re-fetches after every write.
 *
 * A `notLive` banner is shown when the source is a demo-seed. Governed refusals surface as
 * `Forbidden` (reason verbatim).
 */
export function KanbanWorkflowRenderer({ view, os }: { view: KanbanWorkflowConfig; os: OsClient }) {
  const [rows, setRows] = useState<{ status: 'loading' | 'ready' | 'error'; data: AppendedRecord[]; error?: string }>({ status: 'loading', data: [] });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLive, setNotLive] = useState(false);

  const loadRows = useCallback(async () => {
    try {
      const list = await os.records.list();
      setRows({ status: 'ready', data: reduceByKey(recordsFromList(list)) });
    } catch (err: unknown) {
      setRows({ status: 'error', data: [], error: err instanceof Error ? err.message : String(err) });
    }
  }, [os]);

  useEffect(() => {
    setRows({ status: 'loading', data: [] });
    void loadRows();
  }, [loadRows]);

  const moveCard = useCallback(
    async (card: AppendedRecord, toValue: string) => {
      const cardId = String(card.id);
      setError(null);
      setBusyId(cardId);
      const updated: Record<string, unknown> = { ...card, [view.statusField]: toValue };
      delete updated.id;
      try {
        const r = await os.records.update(cardId, updated);
        if (!isRealSave(r.source)) setNotLive(true);
        await loadRows();
      } catch (err: unknown) {
        if (err instanceof Forbidden) setError(err.reason);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [os, view.statusField, loadRows],
  );

  if (rows.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (rows.status === 'error') return <Alert variant="error">Could not load records: {rows.error}</Alert>;

  // Group cards by status column value.
  const colValues = view.columns.map((c) => c.value);
  const grouped = new Map<string, AppendedRecord[]>();
  for (const v of colValues) grouped.set(v, []);
  for (const row of rows.data) {
    const status = String(row[view.statusField] ?? '');
    if (grouped.has(status)) {
      grouped.get(status)!.push(row);
    } else {
      // Unrecognised status — drop into first column or a catch-all.
      const first = colValues[0];
      if (first) grouped.get(first)!.push(row);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notLive && (
        <Alert variant="info">
          The app runner is not live — moves are illustrative (demo-seed), not saved for real.
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}

      <div style={{ display: 'flex', gap: 12, overflowX: 'auto', alignItems: 'flex-start' }}>
        {view.columns.map((col, colIdx) => {
          const cards = grouped.get(col.value) ?? [];
          const prevCol = colIdx > 0 ? view.columns[colIdx - 1] : undefined;
          const nextCol = colIdx < view.columns.length - 1 ? view.columns[colIdx + 1] : undefined;
          return (
            <div
              key={col.value}
              style={{ minWidth: 200, flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div
                style={{
                  fontFamily: 'var(--sb-font-head)',
                  fontWeight: 600,
                  fontSize: 13,
                  color: 'var(--sb-text-muted)',
                  padding: '6px 10px',
                  borderBottom: '2px solid var(--sb-border)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span>{col.label}</span>
                <span
                  style={{
                    fontSize: 11,
                    background: 'var(--sb-border)',
                    borderRadius: 9,
                    padding: '1px 7px',
                    fontWeight: 400,
                  }}
                >
                  {cards.length}
                </span>
              </div>

              {cards.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--sb-text-faint)', padding: '8px 10px' }}>Empty</div>
              ) : null}

              {cards.map((card) => {
                const cardId = String(card.id);
                const busy = busyId === cardId;
                const title = String(card[view.titleField] ?? cardId);
                const subtitles = (view.subtitleFields ?? []).map((f) => String(card[f] ?? '')).filter(Boolean);
                return (
                  <div
                    key={cardId}
                    className="sb-card"
                    style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}
                  >
                    <div style={{ fontFamily: 'var(--sb-font-head)', fontSize: 14, fontWeight: 600, color: 'var(--sb-text)' }}>
                      {title}
                    </div>
                    {subtitles.map((s, i) => (
                      <div key={i} style={{ fontSize: 12.5, color: 'var(--sb-text-muted)' }}>{s}</div>
                    ))}
                    <div style={{ display: 'flex', gap: 6 }}>
                      {prevCol ? (
                        <Button variant="ghost" onClick={() => moveCard(card, prevCol.value)} disabled={busy} style={{ fontSize: 12, padding: '2px 8px' }}>
                          ‹ {prevCol.label}
                        </Button>
                      ) : null}
                      {nextCol ? (
                        <Button onClick={() => moveCard(card, nextCol.value)} disabled={busy} style={{ fontSize: 12, padding: '2px 8px' }}>
                          {nextCol.label} ›
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
