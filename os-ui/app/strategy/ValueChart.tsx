/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { euro } from '@/lib/strategy/model';
import { fmtMonth, type ValuePoint } from './types';

/**
 * The value metric over time — a clean gold line + soft area fill, pure inline
 * SVG (no chart library). Scales to a fixed viewBox and stretches to its
 * container width. Honest empty state when there is no history yet.
 */
export default function ValueChart({
  points,
  height = 180,
  scale = 1,
}: {
  points: ValuePoint[];
  height?: number;
  /** Multiply every value (e.g. a bet's share of the pillar metric). */
  scale?: number;
}) {
  const data = points.map((p) => ({ month: p.month, value: p.value * scale }));
  if (data.length === 0) {
    return (
      <div className="strat-chart-empty">
        No history yet — record a monthly value or set up a governed metric to start the curve.
      </div>
    );
  }

  const W = 720;
  const H = 240;
  const padX = 16;
  const padTop = 18;
  const padBottom = 34;
  const values = data.map((d) => d.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBottom;

  const x = (i: number) => padX + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => padTop + innerH - ((v - min) / span) * innerH;

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${(padTop + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padTop + innerH).toFixed(1)} Z`;
  const last = data[data.length - 1];

  // Show at most ~6 month ticks so the axis never crowds.
  const tickEvery = Math.max(1, Math.ceil(data.length / 6));

  return (
    <svg className="strat-chart" viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height }} role="img" aria-label="Value metric over time">
      <defs>
        <linearGradient id="stratArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--gold)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--gold)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#stratArea)" />
      <path d={line} fill="none" stroke="var(--gold)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) => (
        <g key={d.month}>
          <circle cx={x(i)} cy={y(d.value)} r={i === data.length - 1 ? 4.5 : 3} fill="var(--gold-light)" stroke="var(--bg-input)" strokeWidth="1.5" />
          {i % tickEvery === 0 || i === data.length - 1 ? (
            <text x={x(i)} y={H - 12} textAnchor="middle" className="strat-chart-tick">{fmtMonth(d.month)}</text>
          ) : null}
        </g>
      ))}
      <text x={x(data.length - 1)} y={Math.max(y(last.value) - 10, 14)} textAnchor="end" className="strat-chart-last">
        {euro(last.value)}
      </text>
    </svg>
  );
}
