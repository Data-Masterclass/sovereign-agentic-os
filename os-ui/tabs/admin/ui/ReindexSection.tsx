/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Re-index — Plan the Files / Knowledge index debt, then pay it down
 * USER STORY: As a platform admin I want to see what is wrong with each search index, run the
 *             re-index in batches I can watch, and be told plainly that a clean "marked" count
 *             is not a clean corpus — so I choose "everything" when that is what the cluster's
 *             history requires.
 * ARCHITECTURE:
 *   - A SHELL over `/api/platform-admin/reindex`. Nothing worth testing lives here: every
 *     sentence and every predicate is `tabs/admin/lib/reindex-view.ts` (a test cannot import a
 *     `.tsx`), and every decision is `tabs/{files,knowledge}/lib/reindex.ts`.
 *   - FAIL CLOSED like the other admin sections: the inner component holds every hook and every
 *     fetch and is not mounted until `useUser()` resolves a role that clears
 *     `sectionMinRole('reindex')`.
 *   - PROBE FIRST, THEN OFFER. The panel never enables Run on its own judgement: `runDisabledReason`
 *     is the single computation behind both `disabled` and `title`, so a disabled button always
 *     says which component is down — the plan carries the probe and the reason.
 *   - RUN IS A LOOP OF BOUNDED CALLS, not one long request. Each POST does one batch and returns
 *     the job; the panel keeps calling while `status === 'running'`, so a browser tab that is
 *     closed halfway loses nothing but the polling — the job's cursor is server-side and the next
 *     call resumes it (and a resume does NOT re-plan: review M4). The operator chooses the batch
 *     size, is shown the estimate before starting, and must confirm `all` explicitly, because
 *     `all` re-parses and re-embeds rows that are already correct.
 *   - CONTINUE GATES ON `inFlight`, NEVER ON `status` (review H2). A job left `running` by an
 *     interrupted loop or a closed tab is exactly what needs continuing; the first version greyed
 *     the button out precisely then. And ABANDON (review H3) is the way out of a job whose server
 *     process died mid-batch, which no other door could clear.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import {
  BATCH_CHOICES,
  MARKED_VS_ALL_COPY,
  REINDEX_TARGET_VIEWS,
  abandonDisabledReason,
  confirmRunText,
  engineLines,
  progressLabel,
  reasonRows,
  runButtonLabel,
  runDisabledReason,
  runEstimate,
} from '@tabs/admin/lib/reindex-view';
import type { ReindexFilter, ReindexJob, ReindexPlan, ReindexTarget } from '@core/kernel/reindex';

export default function ReindexSection() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('reindex'))) return null;
  return <ReindexSectionInner />;
}

type Answer = {
  plan?: ReindexPlan;
  job?: ReindexJob | null;
  started?: boolean;
  abandoned?: boolean;
  reason?: string | null;
  error?: string;
  code?: string;
};

function ReindexSectionInner() {
  const [target, setTarget] = useState<ReindexTarget>('files');
  const [filter, setFilter] = useState<ReindexFilter>('marked');
  const [plan, setPlan] = useState<ReindexPlan | null>(null);
  const [job, setJob] = useState<ReindexJob | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [batch, setBatch] = useState<number>(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const post = useCallback(
    async (mode: 'plan' | 'run' | 'abandon'): Promise<Answer> => {
      const res = await fetch('/api/platform-admin/reindex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ target, mode, filter, batch }),
      });
      const body = (await res.json().catch(() => ({}))) as Answer;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    },
    [target, filter, batch],
  );

  /** Read the target's current job on arrival and on a target switch — a GET writes nothing. */
  const loadJob = useCallback(async () => {
    try {
      const res = await fetch(`/api/platform-admin/reindex?target=${target}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { job?: ReindexJob | null; inFlight?: boolean; error?: string };
      setJob(body.job ?? null);
      setInFlight(Boolean(body.inFlight));
    } catch {
      /* a status read that fails changes nothing on screen */
    }
  }, [target]);

  useEffect(() => {
    setPlan(null);
    setError('');
    setNote('');
    void loadJob();
  }, [loadJob]);

  async function doPlan() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const body = await post('plan');
      setPlan(body.plan ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRun() {
    // `all` re-parses and re-embeds rows that are already correct, so the operator confirms the
    // NUMBER before it starts, not after (review M4).
    if (plan) {
      const ask = confirmRunText(plan, batch);
      if (ask && !window.confirm(ask)) return;
    }
    setBusy(true);
    setError('');
    setNote('');
    try {
      // One bounded batch per call; keep going while the server says the job is still running.
      // The server resumes from the cursor and does not re-plan, so each extra call is cheap.
      const maxCalls = plan ? runEstimate(plan, batch).batches + 2 : 200;
      for (let call = 0; call < maxCalls; call++) {
        const body = await post('run');
        const next = body.job ?? null;
        setJob(next);
        if (body.reason === 'already-running') {
          setNote('A batch of this re-index is already running elsewhere; this is its progress.');
          break;
        }
        if (!next || next.status !== 'running') break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await loadJob();
    }
  }

  async function doAbandon() {
    if (!window.confirm(
      'Abandon this re-index? The units already replaced stay replaced; the rest are not touched, ' +
        'and the job is recorded as abandoned by you. You can plan and start again afterwards.',
    )) return;
    setBusy(true);
    setError('');
    try {
      const body = await post('abandon');
      setJob(body.job ?? null);
      setNote(body.abandoned ? 'Abandoned. The target is free to re-run.' : 'Nothing was running; any stale in-flight flag is cleared.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await loadJob();
    }
  }

  const disabled = runDisabledReason(plan, job, busy, inFlight);
  const cannotAbandon = abandonDisabledReason(job, busy, inFlight);
  const view = REINDEX_TARGET_VIEWS.find((t) => t.id === target)!;

  return (
    <section>
      <h3>Re-index</h3>
      <p className="muted" style={{ maxWidth: 820 }}>
        Re-parse and re-embed a search index through the real services. This is the remedy for rows
        written while a document parser or the embeddings gateway was unreachable, before a deployed
        cluster began refusing to stand in for them: invented document text, and hash vectors that
        make every similarity search rank by a hash.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label>
          Index{' '}
          <select value={target} onChange={(e) => setTarget(e.target.value as ReindexTarget)} disabled={busy}>
            {REINDEX_TARGET_VIEWS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scope{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as ReindexFilter)} disabled={busy}>
            <option value="marked">Marked only (cheap, incomplete)</option>
            <option value="all">Everything (complete)</option>
          </select>
        </label>
        <label>
          Batch{' '}
          <select value={batch} onChange={(e) => setBatch(Number(e.target.value))} disabled={busy}>
            {BATCH_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n} units per call
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void doPlan()} disabled={busy}>
          {busy ? 'Working…' : 'Plan'}
        </button>
        <button onClick={() => void doRun()} disabled={disabled !== null} title={disabled ?? 'Run the re-index'}>
          {runButtonLabel(job)}
        </button>
        <button
          className="btn-small"
          onClick={() => void doAbandon()}
          disabled={cannotAbandon !== null}
          title={cannotAbandon ?? 'Give up on the running job and free this index'}
        >
          Abandon
        </button>
      </div>

      <p className="muted" style={{ maxWidth: 820 }}>{view.sub}</p>
      <p className="warn" style={{ maxWidth: 820 }}>{MARKED_VS_ALL_COPY}</p>

      {disabled ? <p className="muted">{disabled}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="muted">{note}</p> : null}

      {plan ? (
        <>
          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>What the plan found</th>
                <th>Count</th>
                <th>What it means</th>
              </tr>
            </thead>
            <tbody>
              {reasonRows(plan).map((row) => (
                <tr key={row.reason}>
                  <td>{row.label}</td>
                  <td>
                    {row.count} {row.unit}
                  </td>
                  <td className="muted">{row.help}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{runEstimate(plan, batch).text}</p>
          <p className="muted">
            {plan.units.length} unit(s) selected by this scope
            {plan.truncated ? ' (capped — run again afterwards for the rest)' : ''}. Index dimension{' '}
            {plan.mappingDim ?? '—'}, configured {plan.configuredDim}.
          </p>
          <ul className="muted">
            {engineLines(plan).map((e) => (
              <li key={e.name}>
                {e.ok ? '✓' : '✗'} {e.name} — {e.text}
              </li>
            ))}
          </ul>
          <p className="muted" style={{ maxWidth: 820 }}>{plan.unmarkedCaveat}</p>
        </>
      ) : null}

      <p style={{ marginTop: 12 }}>
        <strong>Progress</strong> <span className="muted">{progressLabel(job)}</span>
      </p>
      {job && job.failures.length > 0 ? (
        <ul className="muted">
          {job.failures.map((f, i) => (
            <li key={`${f.unit}-${i}`}>
              {f.unit}: {f.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {job?.error ? <p className="error">{job.error}</p> : null}
    </section>
  );
}
