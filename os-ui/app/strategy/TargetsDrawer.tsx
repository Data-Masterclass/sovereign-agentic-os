/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import {
  ARTIFACT_KINDS,
  KIND_LABEL,
  emptyAnnualQuarterly,
  type Pillar,
  type TargetSet,
  type ArtifactKind,
} from '@/lib/strategy/model';

/**
 * Set annual north-star targets with quarterly sub-targets. To keep the form
 * Apple-simple the user enters the ANNUAL figure and quarters auto-split evenly;
 * actuals snapshot monthly. Tracks value generated, active Creators & Builders,
 * and certified counts per artifact kind.
 */
export default function TargetsDrawer({
  pillar,
  onClose,
  onSaved,
}: {
  pillar: Pillar;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = pillar.targets;
  const [value, setValue] = useState(t?.valueGenerated.annual ?? 0);
  const [creators, setCreators] = useState(t?.activeCreators.annual ?? 0);
  const [builders, setBuilders] = useState(t?.activeBuilders.annual ?? 0);
  const [certified, setCertified] = useState<Record<ArtifactKind, number>>(() => {
    const init = {} as Record<ArtifactKind, number>;
    for (const k of ARTIFACT_KINDS) init[k] = t?.certified[k].annual ?? 0;
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const certifiedSet = {} as TargetSet['certified'];
      for (const k of ARTIFACT_KINDS) certifiedSet[k] = emptyAnnualQuarterly(Number(certified[k]) || 0);
      const targets: TargetSet = {
        valueGenerated: emptyAnnualQuarterly(Number(value) || 0),
        activeCreators: emptyAnnualQuarterly(Number(creators) || 0),
        activeBuilders: emptyAnnualQuarterly(Number(builders) || 0),
        certified: certifiedSet,
      };
      const res = await fetch(`/api/strategy/pillars/${pillar.id}/targets`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(targets),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Failed to set targets');
      onSaved();
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
          <h2>Targets · {pillar.name}</h2>
          <button className="drawer-x" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body" style={{ display: 'grid', gap: 14 }}>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            Annual north-star targets — quarters auto-split evenly; actuals snapshot monthly.
          </p>

          <NumField label="Value generated (€ / year)" value={value} onChange={setValue} step={50000} />
          <NumField label="Active Creators" value={creators} onChange={setCreators} />
          <NumField label="Active Builders" value={builders} onChange={setBuilders} />

          <div className="section-title" style={{ marginTop: 4, marginBottom: 0 }}>Certified / promoted counts by kind</div>
          {ARTIFACT_KINDS.map((k) => (
            <NumField
              key={k}
              label={KIND_LABEL[k as ArtifactKind]}
              value={certified[k]}
              onChange={(v) => setCertified((c) => ({ ...c, [k]: v }))}
            />
          ))}

          {error ? <div className="error">{error}</div> : null}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn" onClick={save} disabled={busy}>
              {busy ? <span className="spin" /> : 'Save targets'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <span className="muted" style={{ fontSize: 12.5 }}>{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: 140, textAlign: 'right' }}
      />
    </label>
  );
}
