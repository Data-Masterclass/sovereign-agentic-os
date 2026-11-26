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
 *   - I18N:       converted (wave 2) — texts from `admin.describeFiles.*`. The run's stop reason, failure reasons and
 *     server errors come from the server and render as sent; the model id and currency code are never translated.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { useTranslations, useFormat } from '@core/i18n/client';
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

/** Catalog leaf per skip reason (`admin.describeFiles.skip.*`); an unknown reason renders as sent. */
const SKIP_KEY = {
  restricted: 'restricted',
  'opt-out': 'optOut',
  'no-text': 'noText',
  'user-described': 'userDescribed',
  described: 'described',
  archived: 'archived',
} as const;

export default function DescribeFilesSection() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('reindex'))) return null;
  return <DescribeFilesInner />;
}

function DescribeFilesInner() {
  const t = useTranslations('admin');
  const f = useFormat();
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
    if (!window.confirm(t('describeFiles.confirm', { count: plan.files, billedTo: plan.billedTo }))) return;
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
      if (stop.current) setProgress({ ...total, failed: [...total.failed], note: t('describeFiles.stopped') });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  const skippedRows = plan ? Object.entries(plan.skipped).filter(([, n]) => n > 0) : [];
  const digits = plan?.estimate.cost != null && plan.estimate.cost < 1 ? 4 : 2;
  const cost = plan
    ? plan.estimate.priced && plan.estimate.cost !== null
      ? t('describeFiles.costPriced', { cost: f.number(plan.estimate.cost, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }), currency: plan.estimate.currency })
      : t('describeFiles.costUnpriced', { model: plan.model })
    : '';

  return (
    <section style={{ marginTop: 28 }}>
      <h3>{t('describeFiles.title')}</h3>
      <p className="muted" style={{ maxWidth: 820 }}>
        {t('describeFiles.lead')}
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <input type="checkbox" checked={enabled === true} disabled={enabled === null || busy}
          onChange={(e) => void toggle(e.target.checked)} />
        {t('describeFiles.toggle')}
      </label>

      <p className="muted" style={{ maxWidth: 820 }}>
        {t.rich('describeFiles.existing', { strong: (c) => <strong>{c}</strong> })}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <button onClick={() => void doPlan()} disabled={busy}>{busy && !progress ? t('describeFiles.working') : t('describeFiles.plan')}</button>
        <button onClick={() => void doRun()} disabled={busy || !plan || plan.files === 0 || !plan.enabled}
          title={!plan ? t('describeFiles.runTitle.noPlan') : !plan.enabled ? t('describeFiles.runTitle.off') : plan.files === 0 ? t('describeFiles.runTitle.nothing') : t('describeFiles.runTitle.go')}>
          {plan ? t('describeFiles.runCount', { count: plan.files }) : t('describeFiles.runNoPlan')}
        </button>
        {busy && progress ? <button className="btn-small" onClick={() => { stop.current = true; }}>{t('describeFiles.stop')}</button> : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {plan ? (
        <>
          <p className="muted" style={{ maxWidth: 820 }}>
            {t.rich('describeFiles.planLine', {
              count: plan.files,
              model: plan.model,
              input: f.number(plan.estimate.inputTokens),
              output: f.number(plan.estimate.outputTokens),
              cost,
              mono: (c) => <span className="mono">{c}</span>,
            })}
          </p>
          {skippedRows.length > 0 ? (
            <ul className="muted">
              {skippedRows.map(([reason, n]) => <li key={reason}>{t('describeFiles.leftAlone', { count: n, reason: SKIP_KEY[reason as keyof typeof SKIP_KEY] ? t(`describeFiles.skip.${SKIP_KEY[reason as keyof typeof SKIP_KEY]}`) : reason })}</li>)}
            </ul>
          ) : null}
        </>
      ) : null}

      {progress ? (
        <>
          <p style={{ marginTop: 12 }}>
            <strong>{t('describeFiles.progressTitle')}</strong>{' '}
            <span className="muted">
              {t('describeFiles.progress', { described: progress.described, failed: progress.failed.length, skipped: progress.skipped, remaining: progress.remaining })}
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
