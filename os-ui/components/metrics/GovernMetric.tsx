/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';
import { useUser } from '@/lib/useUser';
import {
  type GovernResult,
  type MetricSummary,
  TIER_BADGE,
  TIER_WORD,
  ChecksList,
} from './shared';

/**
 * Govern a metric — promote it into the domain (Builder) or certify it to the marketplace
 * (Admin). The buttons are role-gated client-side, and the server enforces both the role
 * gate AND the consistency gate (documented + defined + resolves on its canonical member).
 * Either way we render the consistency checks — the audit trail of WHY it moved or didn't.
 */
export default function GovernMetric({
  metric,
  onGoverned,
}: {
  metric: MetricSummary | null;
  onGoverned: () => void;
}) {
  const { user } = useUser();
  const [busy, setBusy] = useState<'promote' | 'certify' | ''>('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<GovernResult | null>(null);

  const role = user?.role;
  const canPromote = role === 'builder' || role === 'admin';
  const canCertify = role === 'admin';

  const govern = useCallback(async (transition: 'promote' | 'certify') => {
    if (!metric) return;
    setErr(''); setBusy(transition); setResult(null);
    try {
      const res = await fetch('/api/metrics/govern', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metricId: metric.id, transition }),
      });
      const data = await res.json();
      // 200 → moved; 403 → denied with a reason + the same consistency rows.
      if (res.status >= 500) { setErr(data.error ?? 'Governance failed'); return; }
      setResult(data);
      if (data.ok) onGoverned();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [metric, onGoverned]);

  if (!metric) {
    return (
      <div className="stub-page" style={{ marginTop: 20 }}>
        Pick a metric in <strong>Registry</strong> first, then govern it here.
      </div>
    );
  }

  return (
    <>
      <p className="lead" style={{ marginTop: 4 }}>
        Move <strong>{metric.name}</strong> along its lifecycle. A metric is a governed product:
        <strong> Personal → Domain</strong> (a Builder promotes) <strong>→ Marketplace</strong>
        (an Admin certifies). The consistency gate must pass first.
      </p>

      <div className="guided-panel">
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted mono" style={{ fontSize: 12 }}>{metric.member}</span>
          <span className={`badge ${TIER_BADGE[metric.tier]}`}>{TIER_WORD[metric.tier]}</span>
        </div>
        <div className="row" style={{ gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => govern('promote')} disabled={!canPromote || busy !== ''}>
            {busy === 'promote' ? <span className="spin" /> : 'Promote → Domain'}
          </button>
          <button className="btn" onClick={() => govern('certify')} disabled={!canCertify || busy !== ''}>
            {busy === 'certify' ? <span className="spin" /> : 'Certify → Marketplace'}
          </button>
        </div>
        {role && !canPromote ? (
          <p className="hint" style={{ marginTop: 10 }}>
            You are signed in as <strong>{role}</strong>. Builders promote; admins certify.
          </p>
        ) : null}
      </div>

      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {result ? (
        <>
          <div className="section-title">
            {result.ok ? 'Promoted' : 'Gate not passed'}
            {result.ok && result.tier ? <span className={`badge ${TIER_BADGE[result.tier]}`}>{TIER_WORD[result.tier]}</span> : null}
          </div>
          {!result.ok && result.reason ? (
            <div className="passthrough-note" style={{ marginTop: 0 }}>{result.reason}</div>
          ) : null}
          <p className="hint" style={{ marginTop: 10, marginBottom: 4 }}>Consistency gate</p>
          <ChecksList rows={result.consistency.rows} />
        </>
      ) : null}
    </>
  );
}
