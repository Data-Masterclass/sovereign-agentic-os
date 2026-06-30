/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useEffect, useState } from 'react';
import type { MetricLink, PillarScope } from '@/lib/strategy/model';

/**
 * Define a pillar: name + description, scope (shared tenant — Admin only — or a
 * domain pillar), and the governed business-value metric it tracks (picked from
 * the Metrics catalogue, referenced not copied).
 */
export default function NewPillarDrawer({
  canCreateTenant,
  domains,
  onClose,
  onCreated,
}: {
  canCreateTenant: boolean;
  domains: string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<PillarScope>(canCreateTenant ? 'tenant' : 'domain');
  const [domain, setDomain] = useState(domains[0] ?? '');
  const [metrics, setMetrics] = useState<MetricLink[]>([]);
  const [metricIdx, setMetricIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/strategy/catalogue', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setMetrics(j.metrics ?? []))
      .catch(() => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const metric = metrics[metricIdx];
      const res = await fetch('/api/strategy/pillars', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          scope,
          domain: scope === 'domain' ? domain : undefined,
          metrics: metric ? [metric] : [],
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to create pillar');
      onCreated(body.item.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Define a pillar</h2>
          <button className="drawer-x" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body" style={{ display: 'grid', gap: 14 }}>
          <Field label="Name">
            <input type="text" value={name} placeholder="Retention" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Strategic intent (business terms)">
            <textarea
              value={description}
              rows={3}
              placeholder="Keep more of the revenue we win: reduce churn and win lapsed customers back."
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Field label="Scope">
            <div className="rt-seg">
              {canCreateTenant ? (
                <button className={`rt-seg-opt${scope === 'tenant' ? ' active' : ''}`} onClick={() => setScope('tenant')}>
                  Shared · tenant
                </button>
              ) : null}
              <button className={`rt-seg-opt${scope === 'domain' ? ' active' : ''}`} onClick={() => setScope('domain')}>
                Domain
              </button>
            </div>
          </Field>

          {scope === 'domain' ? (
            <Field label="Domain">
              <select value={domain} onChange={(e) => setDomain(e.target.value)}>
                {domains.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field label="Business value metric (governed Cube metric)">
            <select value={metricIdx} onChange={(e) => setMetricIdx(Number(e.target.value))}>
              {metrics.map((m, i) => (
                <option key={`${m.cube}.${m.measure}`} value={i}>
                  {m.title} ({m.basis})
                </option>
              ))}
            </select>
          </Field>

          {error ? <div className="error">{error}</div> : null}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn" onClick={submit} disabled={busy || !name.trim()}>
              {busy ? <span className="spin" /> : 'Define pillar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 5 }}>
      <span className="muted" style={{ fontSize: 11.5, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
