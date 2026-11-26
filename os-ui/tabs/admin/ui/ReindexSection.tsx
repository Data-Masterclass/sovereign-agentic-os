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
 *   - I18N:       converted (wave 2) — texts from `admin.reindex.*`, chosen by reindex-view.ts's codes (which keeps
 *     the English). Blocked reasons, the plan's caveat, engine details and failures come from the server as sent.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { useTranslations } from '@core/i18n/client';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import {
  BATCH_CHOICES,
  REASON_KEY,
  REINDEX_TARGET_VIEWS,
  abandonDisabledCode,
  reasonRows,
  runDisabledCode,
  runEstimate,
} from '@tabs/admin/lib/reindex-view';
import type { ReindexFilter, ReindexJob, ReindexPlan, ReindexTarget } from '@core/kernel/reindex';

type T = ReturnType<typeof useTranslations<'admin'>>;

/** The estimate sentence (reindex-view.ts `runEstimate().text` in English). */
function estimateText(plan: ReindexPlan | null, batch: number, t: T): string {
  const est = runEstimate(plan, batch);
  return est.units === 0 ? t('reindex.estimate.none') : t('reindex.estimate.text', { units: est.units, rows: est.rows, batches: est.batches, batch });
}

/** One line of progress (reindex-view.ts `progressLabel` in English). */
function progressText(job: ReindexJob | null, t: T): string {
  if (!job) return t('reindex.progress.notRun');
  const parts = [t('reindex.progress.replaced', { count: job.replaced })];
  if (job.failed) parts.push(t('reindex.progress.failedCount', { count: job.failed }));
  if (job.skipped) parts.push(t('reindex.progress.skipped', { count: job.skipped }));
  const details = parts.join(' · ');
  const left = Math.max(0, job.total - job.cursor);
  if (job.status === 'running') return t('reindex.progress.running', { cursor: job.cursor, total: job.total, left, details });
  if (job.status === 'done') return t('reindex.progress.done', { cursor: job.cursor, total: job.total, details });
  return t('reindex.progress.failed', { cursor: job.cursor, total: job.total, details });
}

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
  const t = useTranslations('admin');
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
    if (plan && plan.filter === 'all') {
      const ask = t('reindex.confirmAll', { target: t(`reindex.targets.${plan.target}.name`), estimate: estimateText(plan, batch, t) });
      if (!window.confirm(ask)) return;
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
          setNote(t('reindex.alreadyRunning'));
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
    if (!window.confirm(t('reindex.abandonConfirm'))) return;
    setBusy(true);
    setError('');
    try {
      const body = await post('abandon');
      setJob(body.job ?? null);
      setNote(body.abandoned ? t('reindex.abandoned') : t('reindex.nothingAbandoned'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await loadJob();
    }
  }

  // One computation each (reindex-view.ts); a `blocked` plan shows the server's own reason as sent.
  const disabledCode = runDisabledCode(plan, job, busy, inFlight);
  const disabled = disabledCode === null ? null
    : disabledCode === 'blocked' ? (plan?.blockedReason ?? t('reindex.disabled.notReady'))
      : t(`reindex.disabled.${disabledCode}`);
  const abandonCode = abandonDisabledCode(job, busy, inFlight);
  const cannotAbandon = abandonCode === null ? null : t(`reindex.abandonDisabled.${abandonCode}`);
  const view = REINDEX_TARGET_VIEWS.find((v) => v.id === target)!;

  return (
    <section>
      <h3>{t('reindex.title')}</h3>
      <p className="muted" style={{ maxWidth: 820 }}>
        {t('reindex.lead')}
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <label>
          {t('reindex.index')}{' '}
          <select value={target} onChange={(e) => setTarget(e.target.value as ReindexTarget)} disabled={busy}>
            {REINDEX_TARGET_VIEWS.map((v) => (
              <option key={v.id} value={v.id}>
                {t(`reindex.targets.${v.id}.label`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('reindex.scope')}{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as ReindexFilter)} disabled={busy}>
            <option value="marked">{t('reindex.scopeMarked')}</option>
            <option value="all">{t('reindex.scopeAll')}</option>
          </select>
        </label>
        <label>
          {t('reindex.batch')}{' '}
          <select value={batch} onChange={(e) => setBatch(Number(e.target.value))} disabled={busy}>
            {BATCH_CHOICES.map((n) => (
              <option key={n} value={n}>
                {t('reindex.batchOption', { count: n })}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => void doPlan()} disabled={busy}>
          {busy ? t('reindex.working') : t('reindex.plan')}
        </button>
        <button onClick={() => void doRun()} disabled={disabled !== null} title={disabled ?? t('reindex.runTitle')}>
          {job?.status === 'running' ? t('reindex.continue', { cursor: job.cursor, total: job.total }) : t('reindex.run')}
        </button>
        <button
          className="btn-small"
          onClick={() => void doAbandon()}
          disabled={cannotAbandon !== null}
          title={cannotAbandon ?? t('reindex.abandonTitle')}
        >
          {t('reindex.abandon')}
        </button>
      </div>

      <p className="muted" style={{ maxWidth: 820 }}>{t(`reindex.targets.${view.id}.sub`)}</p>
      <p className="warn" style={{ maxWidth: 820 }}>{t('reindex.markedVsAll')}</p>

      {disabled ? <p className="muted">{disabled}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="muted">{note}</p> : null}

      {plan ? (
        <>
          <table className="table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>{t('reindex.col.found')}</th>
                <th>{t('reindex.col.count')}</th>
                <th>{t('reindex.col.means')}</th>
              </tr>
            </thead>
            <tbody>
              {reasonRows(plan).map((row) => (
                <tr key={row.reason}>
                  <td>{t(`reindex.reasons.${REASON_KEY[row.reason]}.label`)}</td>
                  <td>
                    {row.unit === 'units' ? t('reindex.units', { count: row.count }) : t('reindex.rows', { count: row.count })}
                  </td>
                  <td className="muted">{t(`reindex.reasons.${REASON_KEY[row.reason]}.help`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{estimateText(plan, batch, t)}</p>
          <p className="muted">
            {t(plan.truncated ? 'reindex.selectedCapped' : 'reindex.selected', { count: plan.units.length, dim: plan.mappingDim ?? '—', configured: plan.configuredDim })}
          </p>
          <ul className="muted">
            {plan.engines.map((e) => (
              <li key={e.name}>
                {e.ready ? '✓' : '✗'} {e.name} — {e.ready
                  ? t('reindex.engineReachable', { url: e.url })
                  : e.detail ? t('reindex.engineUnreachableDetail', { url: e.url, detail: e.detail }) : t('reindex.engineUnreachable', { url: e.url })}
              </li>
            ))}
          </ul>
          <p className="muted" style={{ maxWidth: 820 }}>{plan.unmarkedCaveat}</p>
        </>
      ) : null}

      <p style={{ marginTop: 12 }}>
        <strong>{t('reindex.progressTitle')}</strong> <span className="muted">{progressText(job, t)}</span>
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
