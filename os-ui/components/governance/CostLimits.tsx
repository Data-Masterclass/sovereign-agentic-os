/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

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
      if (!res.ok) setError(body.error ?? 'Failed to load caps');
      else setData(body as CostData);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

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
      if (!res.ok) setError(body.error ?? 'Set cap failed');
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
  }, [scope, subject, limit, period, modelClass, load]);

  const parsedLimit = parseFloat(limit);
  const canSubmit = !busy && subject.trim().length > 0 && !isNaN(parsedLimit) && parsedLimit > 0;

  return (
    <div>
      <div className="section-title">
        Cost caps
        {data && <span className="count-pill">{data.caps.length} caps</span>}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px' }}
          onClick={load}
        >
          Refresh
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Live spend metrics live in the Monitoring tab. Caps here enforce hard limits before
        costs are incurred.
      </p>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {!data && !error && <div className="stub-page">Loading caps…</div>}

      {data && data.caps.length === 0 && (
        <div className="stub-page" style={{ marginBottom: 20 }}>No cost caps configured.</div>
      )}

      {data && data.caps.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 24 }}>
          <table>
            <thead>
              <tr>
                <th>Scope</th>
                <th>Subject</th>
                <th>Limit</th>
                <th>Period</th>
                <th>Model class</th>
                <th>Created by</th>
                <th>Set</th>
              </tr>
            </thead>
            <tbody>
              {data.caps.map((c) => (
                <tr key={c.id}>
                  <td><span className="badge">{c.scope}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.subject}</td>
                  <td style={{ fontWeight: 600 }}>${c.limit.toFixed(2)}</td>
                  <td style={{ fontSize: 12 }}>{c.period ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.modelClass ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.createdBy}</td>
                  <td style={{ fontSize: 12 }}>{new Date(c.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.canSet && (
        <>
          <div className="section-title">Set cap</div>
          <div className="card">
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div>
                <div className="hint" style={{ marginBottom: 4 }}>Scope</div>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as typeof scope)}
                  style={{ minWidth: 110 }}
                >
                  <option value="key">key</option>
                  <option value="domain">domain</option>
                  <option value="tenant">tenant</option>
                </select>
              </div>
              <div style={{ flex: '1 1 140px' }}>
                <div className="hint" style={{ marginBottom: 4 }}>Subject</div>
                <input
                  type="text"
                  style={{ padding: '8px 12px' }}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="key id / domain / tenant id"
                />
              </div>
              <div style={{ flex: '0 0 110px' }}>
                <div className="hint" style={{ marginBottom: 4 }}>Limit ($)</div>
                <input
                  type="text"
                  style={{ padding: '8px 12px' }}
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder="e.g. 100"
                />
              </div>
              <div>
                <div className="hint" style={{ marginBottom: 4 }}>Period</div>
                <select
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as typeof period)}
                  style={{ minWidth: 110 }}
                >
                  <option value="">no period</option>
                  <option value="day">per day</option>
                  <option value="month">per month</option>
                </select>
              </div>
              <div style={{ flex: '1 1 120px' }}>
                <div className="hint" style={{ marginBottom: 4 }}>Model class (opt.)</div>
                <input
                  type="text"
                  style={{ padding: '8px 12px' }}
                  value={modelClass}
                  onChange={(e) => setModelClass(e.target.value)}
                  placeholder="e.g. claude-3-5"
                />
              </div>
              <button className="btn" disabled={!canSubmit} onClick={setCap}>
                {busy ? <span className="spin" /> : 'Set cap'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
