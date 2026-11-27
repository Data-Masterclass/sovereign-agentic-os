/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * TAB:        monitoring
 * FEATURE:    The tenant spend section — spend vs envelope, the STACKIT premium
 *             ceiling, the recent trend, and the envelope figures themselves.
 * USER STORY: As an admin I want tenant spend where I already watch everything else
 *             that runs, instead of in a Platform tab of its own.
 * ARCHITECTURE:
 *   - Moved verbatim from `app/(govern)/platform/billing/page.tsx`; the markup is
 *     unchanged, only the page header and the sibling GatewayPanel stayed behind
 *     (the panel is rendered next to this section by the Monitoring page, because a
 *     tab may not import another tab — see check-structure rule 2).
 *   - Reads `/api/platform-admin/billing`, which stays admin-gated by `adminCtx()`.
 *     The caller ALSO role-gates this component: tenant-wide spend is admin-only and
 *     the Monitoring tab is builder-visible.
 *   - Display logic only; the percentages and hard-stop flags are computed in
 *     `@tabs/monitoring/lib/spend` so they can be unit-tested.
 *   - i18n: labels through the `monitoring` catalog (`spend.*`), figures through `format.ts` with the active
 *     locale. The API's `error` and `billing.reason` texts are server-written and shown verbatim (wave 4).
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BillingView } from '@tabs/monitoring/lib/spend';
import { useTranslations, useFormat } from '@core/i18n/client';
import { count, euros, pct100 } from '@tabs/monitoring/ui/format';

export default function SpendSection() {
  const t = useTranslations('monitoring');
  const { locale } = useFormat();
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [plan, setPlan] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [envelope, setEnvelope] = useState('');
  const [premiumCap, setPremiumCap] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/billing', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('spend.loadFailed'));
      else {
        setBilling(body.billing ?? null);
        setPlan(body.plan ?? '');
        setEnvelope(String(body.billing?.envelopeEUR ?? ''));
        setPremiumCap(String(body.billing?.premiumCapEUR ?? ''));
      }
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` only labels the fallback error; reloading on it is not wanted
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setBusy('save');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/billing', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelopeEUR: Number(envelope), premiumCapEUR: Number(premiumCap) }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('spend.saveFailed'));
      else await load();
    } finally {
      setBusy('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see load
  }, [envelope, premiumCap, load]);

  const trendMax = billing?.trend?.length ? Math.max(...billing.trend, 1) : 1;

  return (
    <>
      <div className="section-title" id="spend" style={{ marginTop: 26 }}>{t('spend.title')}</div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
        {t.rich('spend.hint', { strong: (c) => <strong>{c}</strong>, link: (c) => <a href="/governance">{c}</a> })}{' '}
        {plan ? t.rich('spend.plan', { plan, strong: (c) => <strong>{c}</strong> }) : null}
      </p>

      {error ? <div className="error">{error}</div> : null}

      {billing ? (
        <>
          <div className="pa-kpis" style={{ marginTop: 6 }}>
            <div className="card pa-kpi">
              <span className="k-label">{t('spend.vsEnvelope')}</span>
              <span className="k-value">{billing.pctUsed === null ? '—' : pct100(billing.pctUsed, locale)}</span>
              <div className={`pa-bar${billing.hardStop ? ' stop' : (billing.pctUsed ?? 0) >= 80 ? ' warn' : ''}`}>
                <span style={{ width: `${Math.min(100, billing.pctUsed ?? 0)}%` }} />
              </div>
              <span className="k-sub">
                {t('spend.perMonth', { spend: billing.spendEUR === null ? t('spend.notReadable') : euros(billing.spendEUR, locale), cap: euros(billing.envelopeEUR, locale) })}{billing.hardStop ? ` ${t('spend.hardStop')}` : ''}
              </span>
            </div>
            <div className="card pa-kpi">
              <span className="k-label">{t('spend.premiumCap')}</span>
              <span className="k-value">{billing.premiumPctUsed === null ? '—' : pct100(billing.premiumPctUsed, locale)}</span>
              <div className={`pa-bar${billing.premiumHardStop ? ' stop' : (billing.premiumPctUsed ?? 0) >= 80 ? ' warn' : ''}`}>
                <span style={{ width: `${Math.min(100, billing.premiumPctUsed ?? 0)}%` }} />
              </div>
              <span className="k-sub">
                {t('spend.perMonth', { spend: billing.premiumSpendEUR === null ? t('spend.notReadable') : euros(billing.premiumSpendEUR, locale), cap: euros(billing.premiumCapEUR, locale) })}{billing.premiumHardStop ? ` ${t('spend.hardStop')}` : ''}
              </span>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 22 }}>{t('spend.trend')}</div>
          {billing.trend?.length ? (
            <div className="card">
              <div className="row" style={{ gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                {billing.trend.map((v, i) => (
                  <div key={i} title={euros(v, locale)} style={{ flex: '1 1 18px', minWidth: 18 }}>
                    <div className="pa-bar" style={{ height: 60, display: 'flex', alignItems: 'flex-end' }}>
                      <span style={{ width: '100%', height: `${Math.round((v / trendMax) * 100)}%` }} />
                    </div>
                    <div className="mono muted" style={{ fontSize: 10, textAlign: 'center', marginTop: 4 }}>{count(v, locale)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : <div className="hint">{billing.source === 'unavailable' ? t('spend.noTrendUnreadable') : t('spend.noTrend')}</div>}

          <div className="section-title" style={{ marginTop: 22 }}>{t('spend.edit')}</div>
          <div className="card">
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {t('spend.envelopeLabel')}
                {/* i18n-ignore — the field's API name, not prose */}
                <input type="number" value={envelope} onChange={(e) => setEnvelope(e.target.value)} placeholder="envelopeEUR" />
              </label>
              <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {t('spend.premiumLabel')}
                {/* i18n-ignore — the field's API name, not prose */}
                <input type="number" value={premiumCap} onChange={(e) => setPremiumCap(e.target.value)} placeholder="premiumCapEUR" />
              </label>
              <button className="btn" onClick={save} disabled={busy === 'save'}>
                {busy === 'save' ? <span className="spin" /> : t('spend.save')}
              </button>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              {billing.source === 'unavailable'
                ? billing.reason ?? t('spend.unreadable')
                : billing.source === 'offline-mock'
                  ? t('spend.demo')
                  : t('spend.source', { source: billing.source })}
            </div>
          </div>
        </>
      ) : <div className="stub-page" style={{ marginTop: 20 }}>{t('spend.loading')}</div>}
    </>
  );
}
