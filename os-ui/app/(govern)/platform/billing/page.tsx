/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type BillingView = {
  envelopeEUR: number;
  premiumCapEUR: number;
  spendEUR: number;
  premiumSpendEUR: number;
  pctUsed: number;
  premiumPctUsed: number;
  hardStop: boolean;
  premiumHardStop: boolean;
  trend: number[];
  source: string;
};

export default function BillingPage() {
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
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else {
        setBilling(body.billing ?? null);
        setPlan(body.plan ?? '');
        setEnvelope(String(body.billing?.envelopeEUR ?? ''));
        setPremiumCap(String(body.billing?.premiumCapEUR ?? ''));
      }
    } catch (e) {
      setError((e as Error).message);
    }
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
      if (!res.ok) setError(body.error ?? 'Save failed');
      else await load();
    } finally {
      setBusy('');
    }
  }, [envelope, premiumCap, load]);

  const trendMax = billing?.trend?.length ? Math.max(...billing.trend, 1) : 1;

  return (
    <>
      <PageHeader title="Cost & Billing" crumb="platform · the tenant envelope" />
      <div className="content">
        <p className="lead">
          This tab sets the <strong>envelope</strong> — the tenant&apos;s total monthly ceiling.{' '}
          <a href="/governance">Governance</a> allocates operational sub-caps within it;{' '}
          <a href="/monitoring">Monitoring</a> watches live spend against it. {plan ? <>Current plan: <strong>{plan}</strong>.</> : null}
        </p>

        {error ? <div className="error">{error}</div> : null}

        {billing ? (
          <>
            <div className="pa-kpis" style={{ marginTop: 6 }}>
              <div className="card pa-kpi">
                <span className="k-label">Spend vs envelope</span>
                <span className="k-value">{billing.pctUsed}%</span>
                <div className={`pa-bar${billing.hardStop ? ' stop' : billing.pctUsed >= 80 ? ' warn' : ''}`}>
                  <span style={{ width: `${Math.min(100, billing.pctUsed)}%` }} />
                </div>
                <span className="k-sub">€{billing.spendEUR} / €{billing.envelopeEUR} per mo{billing.hardStop ? ' · hard stop' : ''}</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">STACKIT premium cap</span>
                <span className="k-value">{billing.premiumPctUsed}%</span>
                <div className={`pa-bar${billing.premiumHardStop ? ' stop' : billing.premiumPctUsed >= 80 ? ' warn' : ''}`}>
                  <span style={{ width: `${Math.min(100, billing.premiumPctUsed)}%` }} />
                </div>
                <span className="k-sub">€{billing.premiumSpendEUR} / €{billing.premiumCapEUR} per mo{billing.premiumHardStop ? ' · hard stop' : ''}</span>
              </div>
            </div>

            <div className="section-title" style={{ marginTop: 22 }}>Recent trend</div>
            {billing.trend?.length ? (
              <div className="card">
                <div className="row" style={{ gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  {billing.trend.map((v, i) => (
                    <div key={i} title={`€${v}`} style={{ flex: '1 1 18px', minWidth: 18 }}>
                      <div className="pa-bar" style={{ height: 60, display: 'flex', alignItems: 'flex-end' }}>
                        <span style={{ width: '100%', height: `${Math.round((v / trendMax) * 100)}%` }} />
                      </div>
                      <div className="mono muted" style={{ fontSize: 10, textAlign: 'center', marginTop: 4 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : <div className="hint">No trend data.</div>}

            <div className="section-title" style={{ marginTop: 22 }}>Edit envelope</div>
            <div className="card">
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Envelope (€ / mo)
                  <input type="number" value={envelope} onChange={(e) => setEnvelope(e.target.value)} placeholder="envelopeEUR" />
                </label>
                <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Premium cap (€ / mo)
                  <input type="number" value={premiumCap} onChange={(e) => setPremiumCap(e.target.value)} placeholder="premiumCapEUR" />
                </label>
                <button className="btn" onClick={save} disabled={busy === 'save'}>
                  {busy === 'save' ? <span className="spin" /> : 'Save'}
                </button>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                {billing.source === 'offline-mock' ? 'Demo figures; live spend in Monitoring.' : `Source: ${billing.source}`}
              </div>
            </div>
          </>
        ) : <div className="stub-page" style={{ marginTop: 20 }}>Loading…</div>}
      </div>
    </>
  );
}
