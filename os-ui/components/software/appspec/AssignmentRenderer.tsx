/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Input, Select, Spinner } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient, type QueryResult, type RecordResult } from '@/lib/app-sdk/index.ts';
import type { AssignmentConfig } from '@/lib/software/appspec/patterns.ts';
import { pickOptions } from '@/lib/software/appspec/interactive-logic-select.ts';
import { coerceField } from '@/lib/software/appspec/interactive-logic.ts';

/**
 * Render the `assignment` pattern: pick an ITEM (from the granted `source` dataset) and an ASSIGNEE
 * (from the granted `assignTo` dataset), fill any `extraFields`, and APPEND an assignment record
 * `{ itemId, assigneeId, ...extra, at }` via the governed `os.records.add`. This is the "assign a
 * case to an employee" use case done governed — NO in-place mutation of either dataset (both are
 * read-only to the app); the assignment is a new record in the app's own append log.
 *
 * Both datasets are queried once via `os.datasets.query`. Options carry a stable VALUE (a key
 * column when present, else the first column) + a human LABEL (the configured label field). The
 * write result is HONEST: `Forbidden` reason verbatim, demo-seed labelled, only live-app "Assigned."
 */
export function AssignmentRenderer({ view, os }: { view: AssignmentConfig; os: OsClient }) {
  const [items, setItems] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({ status: 'loading' });
  const [assignees, setAssignees] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({ status: 'loading' });

  const [itemId, setItemId] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RecordResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setItems({ status: 'loading' });
    os.datasets
      .query(view.source.datasetId, { limit: 1000 })
      .then((result) => alive && setItems({ status: 'ready', result }))
      .catch((e: unknown) => alive && setItems({ status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [os, view.source.datasetId]);

  useEffect(() => {
    let alive = true;
    setAssignees({ status: 'loading' });
    os.datasets
      .query(view.assignTo.datasetId, { limit: 1000 })
      .then((result) => alive && setAssignees({ status: 'ready', result }))
      .catch((e: unknown) => alive && setAssignees({ status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [os, view.assignTo.datasetId]);

  const itemOptions = useMemo(() => pickOptions(items.result, view.itemLabelField), [items.result, view.itemLabelField]);
  const assigneeOptions = useMemo(() => pickOptions(assignees.result, view.assignTo.optionLabelField), [assignees.result, view.assignTo.optionLabelField]);

  async function submit() {
    setError(null);
    if (itemId === '' || assigneeId === '') {
      setError('Pick both an item and an assignee.');
      return;
    }
    const record: Record<string, unknown> = { itemId, assigneeId, at: new Date().toISOString() };
    for (const f of view.extraFields ?? []) {
      const v = coerceField(f.type, extra[f.name] ?? '');
      if (v !== undefined) record[f.name] = v;
    }
    setSubmitting(true);
    try {
      const r = await os.records.add(record);
      setResult(r);
    } catch (err: unknown) {
      if (err instanceof Forbidden) setError(err.reason);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setItemId('');
    setAssigneeId('');
    setExtra({});
    setResult(null);
    setError(null);
  }

  if (items.status === 'loading' || assignees.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (items.status === 'error') return <Alert variant="error">Could not load items: {items.error}</Alert>;
  if (assignees.status === 'error') return <Alert variant="error">Could not load assignees: {assignees.error}</Alert>;
  if (itemOptions.error) return <Alert variant="error">{itemOptions.error}</Alert>;
  if (assigneeOptions.error) return <Alert variant="error">{assigneeOptions.error}</Alert>;

  if (result) {
    const live = result.source === 'live-app';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
        <Alert variant={live ? 'success' : 'info'}>
          {live ? 'Assigned.' : `Not saved for real — ${result.note ?? 'the app runner is not live (demo-seed).'}`}
        </Alert>
        <div>
          <Button variant="ghost" onClick={reset}>
            New assignment
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        <span>Item</span>
        <Select value={itemId} onChange={(e) => setItemId(e.target.value)}>
          <option value="">Pick an item…</option>
          {itemOptions.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
        <span>Assign to</span>
        <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Pick an assignee…</option>
          {assigneeOptions.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </label>

      {(view.extraFields ?? []).map((f) => (
        <label key={f.name} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
          <span>
            {f.label}
            {f.required ? ' *' : ''}
          </span>
          {f.type === 'boolean' ? (
            <Select value={extra[f.name] ?? ''} onChange={(e) => setExtra((p) => ({ ...p, [f.name]: e.target.value }))}>
              <option value="">—</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          ) : (
            <Input
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
              value={extra[f.name] ?? ''}
              onChange={(e) => setExtra((p) => ({ ...p, [f.name]: e.target.value }))}
            />
          )}
        </label>
      ))}

      {error && <Alert variant="error">{error}</Alert>}

      <div>
        <Button onClick={submit} disabled={submitting}>
          {submitting ? 'Assigning…' : 'Assign'}
        </Button>
      </div>
    </div>
  );
}
