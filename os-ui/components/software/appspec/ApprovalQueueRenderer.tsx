/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Input, Spinner } from '@/lib/app-ui/index.ts';
import { Forbidden, type OsClient, type QueryResult } from '@/lib/app-sdk/index.ts';
import type { ApprovalQueueConfig } from '@/lib/software/appspec/patterns.ts';
import { pickSourceRows, recordsToGrid, type SourceRow } from '@/lib/software/appspec/interactive-logic-select.ts';
import { latestDecisions, recordsFromList, type Decision } from '@/lib/software/appspec/records-reduce.ts';
import { actorStamp } from '@/lib/software/appspec/interactive-logic.ts';

/**
 * Render the `approval-queue` pattern: list pending items (from the app's own `records` OR a
 * granted dataset) and, per item, Approve / Reject with an optional reason. Each decision is
 * APPENDED as a governed record `{ itemId, decision, reason, by, at }` via `os.records.add` — the
 * item's CURRENT decision is DERIVED by reducing the app's own append log (latest wins), so a later
 * decision supersedes an earlier one WITHOUT any in-place mutation (the SDK has no update door).
 *
 * The decision log is re-read after every write, so the surfaced state always reflects the store.
 * A governed refusal surfaces as `Forbidden` (reason verbatim); a demo-seed write is labelled
 * illustrative, never a fake "recorded".
 */
export function ApprovalQueueRenderer({ view, os }: { view: ApprovalQueueConfig; os: OsClient }) {
  const decisionField = view.decisionField ?? 'decision';
  const [items, setItems] = useState<{ status: 'loading' | 'ready' | 'error'; rows?: SourceRow[]; error?: string }>({ status: 'loading' });
  const [decisions, setDecisions] = useState<Map<string, Decision>>(new Map());
  const [by, setBy] = useState('unknown');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLive, setNotLive] = useState(false);

  // Load the pending items (from the app's own records or a granted dataset).
  useEffect(() => {
    let alive = true;
    setItems({ status: 'loading' });
    const load = async (): Promise<SourceRow[]> => {
      if (view.source === 'records') {
        const list = await os.records.list();
        const recs = recordsFromList(list);
        const result: QueryResult = recordsToGrid(recs);
        const picked = pickSourceRows(result, view.titleField, view.subtitleFields);
        if (picked.error) throw new Error(picked.error);
        return picked.rows;
      }
      const result = await os.datasets.query(view.source.datasetId, { limit: 1000 });
      const picked = pickSourceRows(result, view.titleField, view.subtitleFields);
      if (picked.error) throw new Error(picked.error);
      return picked.rows;
    };
    load()
      .then((rows) => alive && setItems({ status: 'ready', rows }))
      .catch((e: unknown) => alive && setItems({ status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [os, view.source, view.titleField, view.subtitleFields]);

  // Load whoami (for the `by` stamp) + the current decision log.
  useEffect(() => {
    let alive = true;
    os.whoami()
      .then((who) => alive && setBy(actorStamp(who)))
      .catch(() => alive && setBy('unknown'));
    return () => {
      alive = false;
    };
  }, [os]);

  const refreshDecisions = useCallback(async () => {
    const list = await os.records.list();
    setDecisions(latestDecisions(recordsFromList(list)));
  }, [os]);

  useEffect(() => {
    let alive = true;
    refreshDecisions().catch(() => alive && setDecisions(new Map()));
    return () => {
      alive = false;
    };
  }, [refreshDecisions]);

  const decide = useCallback(
    async (item: SourceRow, decision: 'approved' | 'rejected') => {
      setError(null);
      const reason = (reasons[item.id] ?? '').trim();
      if (view.reasonRequired && reason === '') {
        setError(`A reason is required to ${decision === 'approved' ? 'approve' : 'reject'} “${item.title}”.`);
        return;
      }
      setBusyId(item.id);
      try {
        const r = await os.records.add({ itemId: item.id, [decisionField]: decision, decision, reason, by, at: new Date().toISOString() });
        if (r.source !== 'live-app') setNotLive(true);
        await refreshDecisions();
        setReasons((p) => ({ ...p, [item.id]: '' }));
      } catch (err: unknown) {
        if (err instanceof Forbidden) setError(err.reason);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyId(null);
      }
    },
    [os, reasons, view.reasonRequired, decisionField, by, refreshDecisions],
  );

  const pending = useMemo(() => items.rows ?? [], [items.rows]);

  if (items.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (items.status === 'error') return <Alert variant="error">Could not load the queue: {items.error}</Alert>;
  if (pending.length === 0) return <Alert variant="info">Nothing to review.</Alert>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
      {notLive && (
        <Alert variant="info">
          The app runner is not live — decisions are illustrative (demo-seed), not saved for real.
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}
      {pending.map((item) => {
        const current = decisions.get(item.id);
        const busy = busyId === item.id;
        return (
          <article
            key={item.id}
            className="sb-card"
            style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--sb-font-head)', fontSize: 15, fontWeight: 600, color: 'var(--sb-text)' }}>
                  {item.title}
                </div>
                {item.subtitle !== '' && (
                  <div style={{ fontSize: 12.5, color: 'var(--sb-text-muted)' }}>{item.subtitle}</div>
                )}
              </div>
              {current && (
                <Badge tone={current.decision === 'approved' ? 'ok' : 'err'}>
                  {current.decision === 'approved' ? 'Approved' : 'Rejected'}
                  {current.by ? ` · ${current.by}` : ''}
                </Badge>
              )}
            </div>

            <Input
              placeholder={view.reasonRequired ? 'Reason (required)' : 'Reason (optional)'}
              value={reasons[item.id] ?? ''}
              onChange={(e) => setReasons((p) => ({ ...p, [item.id]: e.target.value }))}
            />

            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => decide(item, 'approved')} disabled={busy}>
                {busy ? '…' : 'Approve'}
              </Button>
              <Button variant="ghost" onClick={() => decide(item, 'rejected')} disabled={busy}>
                Reject
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
