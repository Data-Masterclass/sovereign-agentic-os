/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { type BetView, type ValueBasis, type AllocationMethod, eur } from '../types';
import { Segmented } from '../ui';

const BASES: { value: ValueBasis; label: string }[] = [
  { value: 'uplift', label: 'Uplift' },
  { value: 'absolute', label: 'Absolute' },
  { value: 'owner-declared', label: 'Owner-declared' },
];
const METHODS: { value: AllocationMethod; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'usage', label: 'Usage' },
  { value: 'equal', label: 'Equal' },
];

export default function ValuePanel({
  view, basis, allocation, onBasis, onAllocation, canEdit, betId, onMutate,
}: {
  view: BetView;
  basis: ValueBasis;
  allocation: AllocationMethod;
  onBasis: (b: ValueBasis) => void;
  onAllocation: (a: AllocationMethod) => void;
  canEdit: boolean;
  betId: string;
  onMutate: () => void;
}) {
  const r = view.value.realized;
  const d = view.value.distribution;
  const gain = r.current - r.baseline;
  const [reporting, setReporting] = useState(false);
  const [amount, setAmount] = useState('');
  const [reportNote, setReportNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [reportErr, setReportErr] = useState('');

  const report = async () => {
    setSaving(true); setReportErr('');
    try {
      const res = await fetch(`/api/big-bets/${betId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ownerDeclaredValue: Number(amount),
          valueBasis: 'owner-declared',
          ...(reportNote.trim() ? { note: reportNote.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
      }
      setReporting(false);
      setAmount(''); setReportNote('');
      onMutate();
    } catch (e) {
      setReportErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Headline value boxes — given room to breathe. */}
      <div className="bb-value-stats">
        <div className="bb-value-box accent">
          <span className="bb-value-box-label">Realized · {basis}</span>
          <span className="bb-value-box-amount">{eur(r.realized)}</span>
          <span className="bb-value-box-foot">of {eur(r.target)} target</span>
        </div>
        <div className="bb-value-box">
          <span className="bb-value-box-label">Target</span>
          <span className="bb-value-box-amount">{eur(r.target)}</span>
          {r.unit ? <span className="bb-value-box-foot">unit · {r.unit}</span> : <span className="bb-value-box-foot">committed value</span>}
        </div>
      </div>

      {/* Baseline → current — the movement, given the most space. */}
      <div className="bb-baseline">
        <span className="bb-baseline-label">Baseline → current</span>
        <div className="bb-baseline-flow">
          <span className="bb-baseline-from">{eur(r.baseline)}</span>
          <span className="bb-baseline-arrow" aria-hidden>→</span>
          <span className="bb-baseline-to">{eur(r.current)}</span>
          {gain !== 0 ? (
            <span className={`bb-baseline-delta${gain > 0 ? ' up' : ' down'}`}>
              {gain > 0 ? '+' : ''}{eur(gain)}
            </span>
          ) : null}
        </div>
        {r.corroboration ? (
          <span className="bb-baseline-corr">
            corroboration: declared {eur(r.corroboration.declared)}, metric uplift {eur(r.corroboration.metric)}
            {r.corroboration.deltaPct !== 0
              ? ` (${r.corroboration.deltaPct > 0 ? '+' : ''}${r.corroboration.deltaPct}% vs metric)`
              : ''}
          </span>
        ) : null}
      </div>

      <div className="row" style={{ gap: 24, marginTop: 22, flexWrap: 'wrap' }}>
        <div>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 5 }}>Value basis</span>
          <Segmented<ValueBasis> value={basis} onChange={onBasis} options={BASES} />
        </div>
        <div>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 5 }}>Allocation</span>
          <Segmented<AllocationMethod> value={allocation} onChange={onAllocation} options={METHODS} />
        </div>
      </div>

      <div className="table-wrap" style={{ marginTop: 22 }}>
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th>Tab</th>
              <th style={{ textAlign: 'right' }}>Value</th>
              <th style={{ textAlign: 'right' }}>Share</th>
              <th style={{ textAlign: 'right' }}>Upstream credit</th>
            </tr>
          </thead>
          <tbody>
            {d.components.length === 0 ? (
              <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '10px 0', fontSize: 12 }}>No components yet.</td></tr>
            ) : null}
            {d.components.map((row) => (
              <tr key={row.refId ?? row.artifactId}>
                <td>
                  {row.title}
                  {row.upstream ? <span className="badge muted" style={{ marginLeft: 8 }}>earns upstream credit</span> : null}
                </td>
                <td className="muted mono" style={{ fontSize: 11.5 }}>{row.tab}</td>
                <td style={{ textAlign: 'right' }}>{eur(row.value)}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{row.sharePct.toFixed(1)}%</td>
                <td className="mono" style={{ textAlign: 'right' }}>{row.upstreamCredit ? eur(row.upstreamCredit) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>
          Bet value {eur(d.betValue)} · allocation {d.allocation}
        </span>
        <span className={d.reconciles ? 'badge ok' : 'badge warn'}>
          {d.reconciles ? '✓ shares reconcile' : '⚠ does not reconcile'} · residual {eur(d.residual)}
        </span>
      </div>

      {canEdit && view.bet.status !== 'archived' ? (
        <div style={{ marginTop: 16 }}>
          {reporting ? (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, display: 'grid', gap: 8 }}>
              <div className="row" style={{ gap: 12 }}>
                <label style={{ display: 'block', flex: 1 }}>
                  <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Amount (€)</span>
                  <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: '100%' }} placeholder="420000" />
                </label>
                <label style={{ display: 'block', flex: 2 }}>
                  <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>Note (optional)</span>
                  <input type="text" value={reportNote} onChange={(e) => setReportNote(e.target.value)} style={{ width: '100%' }} placeholder="Source or rationale" />
                </label>
              </div>
              {reportErr ? <div className="error">{reportErr}</div> : null}
              <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn ghost sm" onClick={() => setReporting(false)} disabled={saving}>Cancel</button>
                <button className="btn sm" onClick={report} disabled={saving || !amount || Number.isNaN(Number(amount))}>
                  {saving ? <span className="spin" /> : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn ghost sm" onClick={() => setReporting(true)}>Report value</button>
          )}
        </div>
      ) : null}
    </div>
  );
}
