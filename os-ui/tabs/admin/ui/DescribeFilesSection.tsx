/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Re-index → Describe files — the switch for automatic descriptions and
 *             the backfill over files that have text but no description or tags
 * USER STORY: As a platform admin I want to turn automatic descriptions on or off for the whole
 *             workspace, and to describe the files uploaded before the feature existed: first
 *             see how many files and roughly what it costs, with nothing written, then run it in
 *             batches I can stop — knowing the model calls are billed to me.
 * ARCHITECTURE:
 *   - A SHELL over `/api/platform-admin/describe-files` (plan = GET, one batch = POST) and the
 *     tenant settings route for the switch. Every decision — which files, what is skipped, the
 *     estimate, the stop-on-outage rule — is `tabs/files/lib/describe.ts`.
 *   - FAIL CLOSED like `ReindexSection`: nothing is mounted or fetched until the role clears
 *     `sectionMinRole('reindex')`.
 *   - RUN IS A LOOP OF BOUNDED CALLS. Each POST describes one batch and returns a cursor; the
 *     loop stops when the server says done, when a batch stops early (the model is unavailable),
 *     or when the admin presses Stop. Closing the tab loses nothing: starting again re-reads the
 *     files, and one that already has a description is no longer a candidate.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';

type Plan = {
  enabled: boolean;
  files: number;
  skipped: Record<string, number>;
  model: string;
  estimate: { inputTokens: number; outputTokens: number; cost: number | null; currency: string; priced: boolean };
  billedTo: string;
};
type Run = {
  started: boolean; reason?: string; processed: number; described: number; skipped: number;
  failures: { id: string; name: string; reason: string }[]; cursor: string | null; remaining: number; done: boolean;
};

const SKIP_LABELS: Record<string, string> = {
  restricted: 'restricted (never sent to a model)',
  'opt-out': 'stored only by their owner’s choice',
  'no-text': 'no text to describe',
  'user-described': 'described by a person',
  described: 'already have a description and tags',
  archived: 'archived',
};

export default function DescribeFilesSection() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('reindex'))) return null;
  return <DescribeFilesInner />;
}

function DescribeFilesInner() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ described: number; failed: Run['failures']; skipped: number; remaining: number; note: string } | null>(null);
  const stop = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/platform-admin/settings', { cache: 'no-store' });
        const body = await res.json();
        if (res.ok) setEnabled(body.settings?.filesAutoDescribe !== false);
      } catch { /* the switch stays unknown; nothing is assumed */ }
    })();
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filesAutoDescribe: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setEnabled(body.settings?.filesAutoDescribe !== false);
      setPlan(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  async function doPlan() {
    setBusy(true); setError(''); setProgress(null);
    try {
      const res = await fetch('/api/platform-admin/describe-files', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPlan(body.plan as Plan);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function doRun() {
    if (!plan) return;
    if (!window.confirm(`Describe ${plan.files} file(s)? Each one is sent to the model once, and the calls are billed to you (${plan.billedTo}).`)) return;
    setBusy(true); setError(''); stop.current = false;
    const total = { described: 0, failed: [] as Run['failures'], skipped: 0, remaining: plan.files, note: '' };
    setProgress({ ...total });
    try {
      let after: string | null = null;
      // One bounded batch per call. The bound on calls is the plan's own size.
      for (let call = 0; call <= plan.files && !stop.current; call++) {
        const res = await fetch('/api/platform-admin/describe-files', {
          method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ after }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        const run = body.run as Run;
        total.described += run.described; total.skipped += run.skipped; total.failed.push(...run.failures); total.remaining = run.remaining;
        if (!run.started || run.reason) total.note = run.reason ?? '';
        setProgress({ ...total, failed: [...total.failed] });
        if (!run.started || run.reason || run.done || run.processed === 0) break;
        after = run.cursor;
      }
      if (stop.current) setProgress({ ...total, failed: [...total.failed], note: 'Stopped. Plan again to continue with the rest.' });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const skippedRows = plan ? Object.entries(plan.skipped).filter(([, n]) => n > 0) : [];
  const cost = plan
    ? plan.estimate.priced && plan.estimate.cost !== null
      ? `about ${plan.estimate.cost.toFixed(plan.estimate.cost < 1 ? 4 : 2)} ${plan.estimate.currency}`
      : `no price is set for ${plan.model}, so no cost can be estimated`
    : '';

  return (
    <section style={{ marginTop: 28 }}>
      <h3>Describe files</h3>
      <p className="muted" style={{ maxWidth: 820 }}>
        Every uploaded file gets a short description and a few tags written from its content, by one
        call on the standard model billed to the person who uploaded it. Restricted files and files
        their owner keeps stored only are never sent to a model. A description or tag a person wrote
        is never replaced.
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="checkbox" checked={enabled === true} disabled={enabled === null || busy}
          onChange={(e) => void toggle(e.target.checked)} />
        Write a description and tags automatically for uploaded files
      </label>

      <p className="muted" style={{ maxWidth: 820 }}>
        <strong>Existing files.</strong> Describe the files that have text but no description or tags.
        Plan first: a plan writes nothing and calls no model. A run is billed to you, the admin who
        starts it, and works in batches you can stop; starting again only touches what is still undescribed.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <button onClick={() => void doPlan()} disabled={busy}>{busy && !progress ? 'Working…' : 'Plan'}</button>
        <button onClick={() => void doRun()} disabled={busy || !plan || plan.files === 0 || !plan.enabled}
          title={!plan ? 'Plan first' : !plan.enabled ? 'Automatic descriptions are switched off' : plan.files === 0 ? 'Nothing to describe' : 'Describe these files, billed to you'}>
          Describe {plan ? plan.files : ''} file{plan && plan.files === 1 ? '' : 's'}
        </button>
        {busy && progress ? <button className="btn-small" onClick={() => { stop.current = true; }}>Stop</button> : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {plan ? (
        <>
          <p className="muted" style={{ maxWidth: 820 }}>
            {plan.files} file(s) would be described with <span className="mono">{plan.model}</span>. Estimate:
            roughly {plan.estimate.inputTokens.toLocaleString('en-US')} input and {plan.estimate.outputTokens.toLocaleString('en-US')} output
            tokens, {cost}. This is an estimate from the text lengths, not a bill.
          </p>
          {skippedRows.length > 0 ? (
            <ul className="muted">
              {skippedRows.map(([reason, n]) => <li key={reason}>{n} left alone: {SKIP_LABELS[reason] ?? reason}</li>)}
            </ul>
          ) : null}
        </>
      ) : null}

      {progress ? (
        <>
          <p style={{ marginTop: 12 }}>
            <strong>Progress</strong>{' '}
            <span className="muted">
              {progress.described} described, {progress.failed.length} failed, {progress.skipped} skipped, {progress.remaining} left.
              {progress.note ? ` ${progress.note}` : ''}
            </span>
          </p>
          {progress.failed.length > 0 ? (
            <ul className="muted">
              {progress.failed.map((f, i) => <li key={`${f.id}-${i}`}>{f.name}: {f.reason}</li>)}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
