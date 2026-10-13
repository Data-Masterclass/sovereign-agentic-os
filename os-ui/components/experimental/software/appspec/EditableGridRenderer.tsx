/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Input, Spinner } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient } from '@/lib/app-sdk/index.ts';
import type { EditableGridConfig } from '@/lib/experimental/software/appspec/patterns.ts';
import { reduceByKey, recordsFromList, type AppendedRecord } from '@/lib/experimental/software/appspec/records-reduce.ts';
import { coerceField, isRealSave } from '@/lib/experimental/software/appspec/interactive-logic.ts';

/**
 * Render the `editable-grid` pattern: a table of the app's OWN records (reduced via
 * `reduceByKey`), with inline-editable cells. Saving a row calls `os.records.update`
 * (append-only supersede); adding a row calls `os.records.add`; deleting a row calls
 * `os.records.remove` (tombstone). The list re-fetches after every write.
 *
 * A `notLive` banner is shown when the source is a demo-seed (not a real durable write).
 * Governed refusals surface as `Forbidden` (reason verbatim).
 */
export function EditableGridRenderer({ view, os }: { view: EditableGridConfig; os: OsClient }) {
  const [rows, setRows] = useState<{ status: 'loading' | 'ready' | 'error'; data: AppendedRecord[]; error?: string }>({ status: 'loading', data: [] });
  const [editing, setEditing] = useState<Record<string, Record<string, string>>>({});
  const [newRow, setNewRow] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
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

  const cellValue = (row: AppendedRecord, field: string): string => {
    const edit = editing[String(row.id)];
    if (edit && field in edit) return edit[field];
    const v = row[field];
    return v === null || v === undefined ? '' : String(v);
  };

  const setCell = (rowId: string, field: string, value: string) => {
    setEditing((prev) => ({
      ...prev,
      [rowId]: { ...(prev[rowId] ?? {}), [field]: value },
    }));
  };

  const saveRow = useCallback(
    async (row: AppendedRecord) => {
      const rowId = String(row.id);
      const edits = editing[rowId] ?? {};
      const merged: Record<string, unknown> = { ...row };
      for (const col of view.columns) {
        if (col.field in edits) {
          const coerced = coerceField(col.type, edits[col.field]);
          if (coerced !== undefined) merged[col.field] = coerced;
          else delete merged[col.field];
        }
      }
      delete merged.id; // the logical key — don't write it as a payload field
      setError(null);
      setBusyId(rowId);
      try {
        const r = await os.records.update(rowId, merged);
        if (!isRealSave(r.source)) setNotLive(true);
        setEditing((prev) => { const next = { ...prev }; delete next[rowId]; return next; });
        await loadRows();
      } catch (err: unknown) {
        if (err instanceof Forbidden) setError(err.reason);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [os, editing, view.columns, loadRows],
  );

  const deleteRow = useCallback(
    async (row: AppendedRecord) => {
      const rowId = String(row.id);
      setError(null);
      setBusyId(rowId);
      try {
        const r = await os.records.remove(rowId);
        if (!isRealSave(r.source)) setNotLive(true);
        await loadRows();
      } catch (err: unknown) {
        if (err instanceof Forbidden) setError(err.reason);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [os, loadRows],
  );

  const addRow = useCallback(async () => {
    const record: Record<string, unknown> = {};
    for (const col of view.columns) {
      const raw = newRow[col.field] ?? '';
      const coerced = coerceField(col.type, raw);
      if (coerced !== undefined) record[col.field] = coerced;
    }
    setError(null);
    setAddBusy(true);
    try {
      const r = await os.records.add(record);
      if (!isRealSave(r.source)) setNotLive(true);
      setNewRow({});
      await loadRows();
    } catch (err: unknown) {
      if (err instanceof Forbidden) setError(err.reason);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddBusy(false);
    }
  }, [os, newRow, view.columns, loadRows]);

  if (rows.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (rows.status === 'error') return <Alert variant="error">Could not load records: {rows.error}</Alert>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {notLive && (
        <Alert variant="info">
          The app runner is not live — edits are illustrative (demo-seed), not saved for real.
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              {view.columns.map((col) => (
                <th
                  key={col.field}
                  style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--sb-border)', color: 'var(--sb-text-muted)', fontWeight: 600, fontFamily: 'var(--sb-font-head)' }}
                >
                  {col.label ?? col.field}
                </th>
              ))}
              <th style={{ padding: '6px 10px', borderBottom: '1px solid var(--sb-border)' }} />
            </tr>
          </thead>
          <tbody>
            {rows.data.length === 0 ? (
              <tr>
                <td colSpan={view.columns.length + 1} style={{ padding: '12px 10px', color: 'var(--sb-text-faint)', textAlign: 'center' }}>
                  No records yet — add one below.
                </td>
              </tr>
            ) : null}
            {rows.data.map((row) => {
              const rowId = String(row.id);
              const busy = busyId === rowId;
              const dirty = !!editing[rowId] && Object.keys(editing[rowId]).length > 0;
              return (
                <tr key={rowId} style={{ borderBottom: '1px solid var(--sb-border)' }}>
                  {view.columns.map((col) => (
                    <td key={col.field} style={{ padding: '6px 10px' }}>
                      <Input
                        value={cellValue(row, col.field)}
                        onChange={(e) => setCell(rowId, col.field, e.target.value)}
                        disabled={busy}
                        style={{ width: '100%', minWidth: 80 }}
                      />
                    </td>
                  ))}
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button onClick={() => saveRow(row)} disabled={busy || !dirty}>
                        {busy ? '…' : 'Save'}
                      </Button>
                      <Button variant="ghost" onClick={() => deleteRow(row)} disabled={busy}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {/* Add-row input */}
            <tr style={{ background: 'var(--sb-surface-alt, var(--sb-surface))' }}>
              {view.columns.map((col) => (
                <td key={col.field} style={{ padding: '6px 10px' }}>
                  <Input
                    placeholder={col.label ?? col.field}
                    value={newRow[col.field] ?? ''}
                    onChange={(e) => setNewRow((prev) => ({ ...prev, [col.field]: e.target.value }))}
                    disabled={addBusy}
                    style={{ width: '100%', minWidth: 80 }}
                  />
                </td>
              ))}
              <td style={{ padding: '6px 10px' }}>
                <Button onClick={addRow} disabled={addBusy}>
                  {addBusy ? '…' : 'Add row'}
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
