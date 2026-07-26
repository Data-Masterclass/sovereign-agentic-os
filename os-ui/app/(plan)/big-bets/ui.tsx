/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { type Readiness, SIGNAL_BADGE, SIGNAL_LABEL } from './types';

/** Thin gold progress bar — same look as the Strategy confidence bar. */
export function ProgressBar({ pct, height = 6 }: { pct: number; height?: number }) {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div
      style={{
        height,
        borderRadius: 999,
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${w}%`,
          height: '100%',
          background: 'linear-gradient(90deg, var(--gold-deep), var(--gold-light))',
          transition: 'width .3s ease',
        }}
      />
    </div>
  );
}

/** Readiness signal as a house badge. */
export function SignalBadge({ signal }: { signal: Readiness }) {
  return <span className={SIGNAL_BADGE[signal]}>{SIGNAL_LABEL[signal]}</span>;
}

/** A labelled segmented toggle (basis / allocation / mode). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="bb-seg" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
