/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spinner } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient } from '@/lib/app-sdk/index.ts';
import type { ActionDetailConfig } from '@/lib/experimental/software/appspec/patterns.ts';
import { reduceByKey, recordsFromList, type AppendedRecord } from '@/lib/experimental/software/appspec/records-reduce.ts';
import { isRealSave } from '@/lib/experimental/software/appspec/interactive-logic.ts';

/**
 * Render the `action-detail` pattern: a record picker (list of reduced records by titleField);
 * selecting a record shows `view.fields` as label/value pairs and exposes each `view.actions`
 * as a button that calls `os.records.update` to set a single field to a fixed value.
 *
 * A `notLive` banner is shown when the source is a demo-seed. Governed refusals surface as
 * `Forbidden` (reason verbatim).
 */
export function ActionDetailRenderer({ view, os }: { view: ActionDetailConfig; os: OsClient }) {
  const [rows, setRows] = useState<{ status: 'loading' | 'ready' | 'error'; data: AppendedRecord[]; error?: string }>({ status: 'loading', data: [] });
  const [selected, setSelected] = useState<AppendedRecord | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLive, setNotLive] = useState(false);

  const loadRows = useCallback(async () => {
    try {
      const list = await os.records.list();
      const data = reduceByKey(recordsFromList(list));
      setRows({ status: 'ready', data });
      // Keep the selected record in sync after a reload.
      setSelected((prev) => {
        if (!prev) return null;
        return data.find((r) => String(r.id) === String(prev.id)) ?? null;
      });
    } catch (err: unknown) {
      setRows({ status: 'error', data: [], error: err instanceof Error ? err.message : String(err) });
    }
  }, [os]);

  useEffect(() => {
    setRows({ status: 'loading', data: [] });
    void loadRows();
  }, [loadRows]);

  const runAction = useCallback(
    async (action: ActionDetailConfig['actions'][number]) => {
      if (!selected) return;
      const recordId = String(selected.id);
      setError(null);
      setBusyAction(action.label);
      const updated: Record<string, unknown> = { ...selected, [action.setField]: action.setValue };
      delete updated.id;
      try {
        const r = await os.records.update(recordId, updated);
        if (!isRealSave(r.source)) setNotLive(true);
        await loadRows();
      } catch (err: unknown) {
        if (err instanceof Forbidden) setError(err.reason);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [os, selected, loadRows],
  );

  if (rows.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (rows.status === 'error') return <Alert variant="error">Could not load records: {rows.error}</Alert>;
  if (rows.data.length === 0) return <Alert variant="info">No records yet.</Alert>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 680 }}>
      {notLive && (
        <Alert variant="info">
          The app runner is not live — actions are illustrative (demo-seed), not saved for real.
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}

      {/* Record picker */}
      <div>
        <label style={{ display: 'block', fontSize: 12.5, color: 'var(--sb-text-muted)', marginBottom: 4 }}>
          Select a record
        </label>
        <select
          className="sb-select"
          value={selected ? String(selected.id) : ''}
          onChange={(e) => {
            const id = e.target.value;
            setSelected(rows.data.find((r) => String(r.id) === id) ?? null);
            setError(null);
          }}
        >
          <option value="">Choose…</option>
          {rows.data.map((row) => (
            <option key={String(row.id)} value={String(row.id)}>
              {String(row[view.titleField] ?? row.id)}
            </option>
          ))}
        </select>
      </div>

      {selected ? (
        <div className="sb-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Fields */}
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px' }}>
            {view.fields.map((f) => (
              <div key={f.field} style={{ display: 'contents' }}>
                <dt style={{ fontSize: 12.5, color: 'var(--sb-text-muted)', fontWeight: 600 }}>
                  {f.label ?? f.field}
                </dt>
                <dd style={{ margin: 0, fontSize: 14, color: 'var(--sb-text)' }}>
                  {String(selected[f.field] ?? '—')}
                </dd>
              </div>
            ))}
          </dl>

          {/* Actions */}
          {view.actions.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid var(--sb-border)' }}>
              {view.actions.map((action, i) => {
                const busy = busyAction === action.label;
                return (
                  <Button
                    key={i}
                    onClick={() => runAction(action)}
                    disabled={!!busyAction}
                    variant={i === 0 ? undefined : 'ghost'}
                  >
                    {busy ? '…' : action.label}
                  </Button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <p style={{ fontSize: 14, color: 'var(--sb-text-faint)', margin: 0 }}>
          Select a record above to see its details and actions.
        </p>
      )}
    </div>
  );
}
