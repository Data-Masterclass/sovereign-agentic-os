/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Cost caps — list and set LLM spend caps per key, domain or tenant
 * USER STORY: As an admin I want to set a spend ceiling per domain or tenant (optionally per period and
 *             model class), so that assistant calls stop before spend runs past the agreed budget.
 * ARCHITECTURE:
 *   - Client component rendered by `app/(govern)/governance/page.tsx`; reads and writes
 *     `GET`/`POST /api/governance/cost`. The form shows only when the server returns `canSet`.
 *   - Enforcement is not here: this panel only edits the caps the server checks.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';

/** `toLocaleDateString()`'s English form, kept byte-identical. */
const LEGACY_DATE: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };

const SCOPE_KEYS = { key: 'cost.scope.key', domain: 'cost.scope.domain', tenant: 'cost.scope.tenant' } as const;
const PERIOD_KEYS = { day: 'cost.period.day', month: 'cost.period.month' } as const;

type Cap = {
  id: string;
  scope: 'key' | 'domain' | 'tenant';
  subject: string;
  limit: number;
  period?: 'day' | 'month';
  modelClass?: string;
  createdBy: string;
  createdAt: string;
};

type CostData = {
  caps: Cap[];
  canSet: boolean;
};

export default function CostLimits() {
  const t = useTranslations('governance');
  const msg = useServerMessage();
  const f = useFormat();
  const [data, setData] = useState<CostData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // form state
  const [scope, setScope] = useState<'key' | 'domain' | 'tenant'>('domain');
  const [subject, setSubject] = useState('');
  const [limit, setLimit] = useState('');
  const [period, setPeriod] = useState<'day' | 'month' | ''>('month');
  const [modelClass, setModelClass] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/governance/cost', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(msg(body, t('cost.loadFailed')));
      else setData(body as CostData);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t, msg]);

  useEffect(() => {
    load();
  }, [load]);

  const setCap = useCallback(async () => {
    const lim = parseFloat(limit);
    if (!subject.trim() || isNaN(lim) || lim <= 0) return;
    setBusy(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        scope,
        subject: subject.trim(),
        limit: lim,
      };
      if (period) payload.period = period;
      if (modelClass.trim()) payload.modelClass = modelClass.trim();

      const res = await fetch('/api/governance/cost', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) setError(msg(body, t('cost.setFailed')));
      else {
        setSubject('');
        setLimit('');
        setModelClass('');
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [scope, subject, limit, period, modelClass, load, t, msg]);

  const parsedLimit = parseFloat(limit);
  const canSubmit = !busy && subject.trim().length > 0 && !isNaN(parsedLimit) && parsedLimit > 0;

  return (
    <div>
      <div className="section-title">
        {t('cost.title')}
        {data && <span className="count-pill">{t('cost.count', { count: data.caps.length })}</span>}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px' }}
          onClick={load}
        >
          {t('actions.refresh')}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        {t('cost.hint')}
      </p>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {!data && !error && <div className="stub-page">{t('cost.loading')}</div>}

      {data && data.caps.length === 0 && (
        <div className="stub-page" style={{ marginBottom: 20 }}>{t('cost.empty')}</div>
      )}

      {data && data.caps.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 24 }}>
          <table>
            <thead>
              <tr>
                <th>{t('cost.th.scope')}</th>
                <th>{t('cost.th.subject')}</th>
                <th>{t('cost.th.limit')}</th>
                <th>{t('cost.th.period')}</th>
                <th>{t('cost.th.modelClass')}</th>
                <th>{t('cost.th.createdBy')}</th>
                <th>{t('cost.th.set')}</th>
              </tr>
            </thead>
            <tbody>
              {data.caps.map((c) => (
                <tr key={c.id}>
                  <td><span className="badge">{c.scope in SCOPE_KEYS ? t(SCOPE_KEYS[c.scope]) : c.scope}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.subject}</td>
                  <td style={{ fontWeight: 600 }}>{f.currency(c.limit, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td style={{ fontSize: 12 }}>{c.period ? (c.period in PERIOD_KEYS ? t(PERIOD_KEYS[c.period]) : c.period) : '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.modelClass ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.createdBy}</td>
                  <td style={{ fontSize: 12 }}>{f.date(c.createdAt, LEGACY_DATE)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.canSet && (
        <>
          <div className="section-title">{t('cost.form.title')}</div>
          <div className="card">
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <div className="hint" style={{ marginBottom: 4 }}>{t('cost.th.scope')}</div>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as typeof scope)}
                  style={{ minWidth: 110 }}
                >
                  <option value="key">{t('cost.scope.key')}</option>
                  <option value="domain">{t('cost.scope.domain')}</option>
                  <option value="tenant">{t('cost.scope.tenant')}</option>
                </select>
              </div>
              <div style={{ flex: '1 1 140px' }}>
                <div className="hint" style={{ marginBottom: 4 }}>{t('cost.th.subject')}</div>
                <input
                  type="text"
                  style={{ padding: '8px 12px' }}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={t('cost.form.subjectPlaceholder')}
                />
              </div>
              <div style={{ flex: '0 0 110px' }}>
                <div className="hint" style={{ marginBottom: 4 }}>{t('cost.form.limit')}</div>
                <input
                  type="text"
                  style={{ padding: '8px 12px' }}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder={t('cost.form.limitPlaceholder')}
                />
              </div>
              <div>
                <div className="hint" style={{ marginBottom: 4 }}>{t('cost.th.period')}</div>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as typeof period)}
                  style={{ minWidth: 110 }}
                >
                  <option value="">{t('cost.form.noPeriod')}</option>
                  <option value="day">{t('cost.form.perDay')}</option>
                  <option value="month">{t('cost.form.perMonth')}</option>
                </select>
              </div>
              <div style={{ flex: '1 1 120px' }}>
                <div className="hint" style={{ marginBottom: 4 }}>{t('cost.form.modelClass')}</div>
                <input
                  type="text"
                  style={{ padding: '8px 12px' }}
                  value={modelClass}
                  onChange={(e) => setModelClass(e.target.value)}
                  placeholder={t('cost.form.modelClassPlaceholder')}
                />
              </div>
              <button className="btn" disabled={!canSubmit} onClick={setCap}>
                {busy ? <span className="spin" /> : t('cost.form.submit')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
