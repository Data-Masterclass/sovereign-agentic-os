/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

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
  view, basis, allocation, onBasis, onAllocation,
}: {
  view: BetView;
  basis: ValueBasis;
  allocation: AllocationMethod;
  onBasis: (b: ValueBasis) => void;
  onAllocation: (a: AllocationMethod) => void;
}) {
  const r = view.value.realized;
  const d = view.value.distribution;

  return (
    <div>
      <div className="row" style={{ gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Stat label={`Realized · ${basis}`} value={eur(r.realized)} accent />
        <Stat label="Target" value={eur(r.target)} />
        <Stat label="Baseline → current" value={`${eur(r.baseline)} → ${eur(r.current)}`} muted />
        {r.unit ? <Stat label="Unit" value={r.unit} muted /> : null}
      </div>
      {r.corroboration ? (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>corroboration: {r.corroboration}</div>
      ) : null}

      <div className="row" style={{ gap: 20, marginTop: 16, flexWrap: 'wrap' }}>
        <div>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 5 }}>Value basis</span>
          <Segmented<ValueBasis> value={basis} onChange={onBasis} options={BASES} />
        </div>
        <div>
          <span className="muted" style={{ fontSize: 11, display: 'block', marginBottom: 5 }}>Allocation</span>
          <Segmented<AllocationMethod> value={allocation} onChange={onAllocation} options={METHODS} />
        </div>
      </div>

      <div className="table-wrap" style={{ marginTop: 16 }}>
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
    </div>
  );
}

function Stat({ label, value, accent, muted }: { label: string; value: string; accent?: boolean; muted?: boolean }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div
        className="big"
        style={{ fontSize: accent ? 22 : 16, color: accent ? 'var(--gold-light)' : muted ? 'var(--text-muted)' : 'var(--text)' }}
      >
        {value}
      </div>
    </div>
  );
}
