/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Spinner } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient, type QueryResult } from '@/lib/app-sdk/index.ts';
import type { TaskChecklistConfig } from '@/lib/software/appspec/patterns.ts';
import { pickSourceRows, recordsToGrid, type SourceRow } from '@/lib/software/appspec/interactive-logic-select.ts';
import { doneTaskIds, recordsFromList } from '@/lib/software/appspec/records-reduce.ts';
import { actorStamp } from '@/lib/software/appspec/interactive-logic.ts';

/**
 * Render the `task-checklist` pattern: a checklist over the app's own `records` OR a granted
 * dataset. Checking / un-checking an item APPENDS a completion record `{ taskId, done, by, at }`
 * via `os.records.add`; the done-state is DERIVED by reducing the append log (latest per task
 * wins — see `doneTaskIds`), so a later `done:false` un-checks an earlier `done:true` WITHOUT any
 * in-place mutation (the SDK has no update door). The log is re-read after every write.
 *
 * A governed refusal surfaces as `Forbidden` (reason verbatim); a demo-seed write is labelled
 * illustrative, never a fake completion.
 */
export function TaskChecklistRenderer({ view, os }: { view: TaskChecklistConfig; os: OsClient }) {
  const [items, setItems] = useState<{ status: 'loading' | 'ready' | 'error'; rows?: SourceRow[]; error?: string }>({ status: 'loading' });
  const [done, setDone] = useState<Set<string>>(new Set());
  const [by, setBy] = useState('unknown');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLive, setNotLive] = useState(false);

  const subtitleFields = view.assigneeField ? [view.assigneeField] : [];

  useEffect(() => {
    let alive = true;
    setItems({ status: 'loading' });
    const load = async (): Promise<SourceRow[]> => {
      let result: QueryResult;
      if (view.source === 'records') {
        result = recordsToGrid(recordsFromList(await os.records.list()));
      } else {
        result = await os.datasets.query(view.source.datasetId, { limit: 1000 });
      }
      const picked = pickSourceRows(result, view.titleField, subtitleFields);
      if (picked.error) throw new Error(picked.error);
      return picked.rows;
    };
    load()
      .then((rows) => alive && setItems({ status: 'ready', rows }))
      .catch((e: unknown) => alive && setItems({ status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [os, view.source, view.titleField, view.assigneeField]);

  useEffect(() => {
    let alive = true;
    os.whoami()
      .then((who) => alive && setBy(actorStamp(who)))
      .catch(() => alive && setBy('unknown'));
    return () => {
      alive = false;
    };
  }, [os]);

  const refreshDone = useCallback(async () => {
    const list = await os.records.list();
    setDone(doneTaskIds(recordsFromList(list)));
  }, [os]);

  useEffect(() => {
    let alive = true;
    refreshDone().catch(() => alive && setDone(new Set()));
    return () => {
      alive = false;
    };
  }, [refreshDone]);

  const toggle = useCallback(
    async (task: SourceRow) => {
      setError(null);
      const next = !done.has(task.id);
      setBusyId(task.id);
      try {
        const r = await os.records.add({ taskId: task.id, done: next, by, at: new Date().toISOString() });
        if (r.source !== 'live-app') setNotLive(true);
        await refreshDone();
      } catch (err: unknown) {
        if (err instanceof Forbidden) setError(err.reason);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [os, done, by, refreshDone],
  );

  if (items.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (items.status === 'error') return <Alert variant="error">Could not load the checklist: {items.error}</Alert>;
  const rows = items.rows ?? [];
  if (rows.length === 0) return <Alert variant="info">Nothing to do.</Alert>;

  const doneCount = rows.filter((r) => done.has(r.id)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
      {notLive && (
        <Alert variant="info">The app runner is not live — completions are illustrative (demo-seed), not saved for real.</Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}

      <div style={{ fontSize: 12.5, color: 'var(--sb-text-faint)' }}>
        {doneCount} of {rows.length} done
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map((task) => {
          const isDone = done.has(task.id);
          const busy = busyId === task.id;
          return (
            <li
              key={task.id}
              className="sb-card"
              style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}
            >
              <input
                type="checkbox"
                checked={isDone}
                disabled={busy}
                onChange={() => toggle(task)}
                aria-label={`Mark “${task.title}” ${isDone ? 'not done' : 'done'}`}
                style={{ width: 18, height: 18, accentColor: 'var(--sb-teal)', cursor: busy ? 'default' : 'pointer' }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 14,
                    color: isDone ? 'var(--sb-text-faint)' : 'var(--sb-text)',
                    textDecoration: isDone ? 'line-through' : 'none',
                  }}
                >
                  {task.title}
                </div>
                {task.subtitle !== '' && (
                  <div style={{ fontSize: 12, color: 'var(--sb-text-muted)' }}>{task.subtitle}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
