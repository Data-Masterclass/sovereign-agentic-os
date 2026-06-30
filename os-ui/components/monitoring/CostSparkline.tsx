/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { HealthItem } from '@/lib/monitoring';
import { moneyPct } from './health';

/**
 * Inline-SVG spend bars with a horizontal cap line — no chart library. Renders
 * only when the cost item carries both a `series` and a `cap`. ≥90% reads amber,
 * ≥100% reads red, otherwise teal — so spend that approaches its cap stands out.
 */
export default function CostSparkline({ item }: { item: HealthItem }) {
  const { series, cap } = item;
  if (!series?.length || !cap) return null;

  const W = 320;
  const H = 44;
  const pad = 2;
  const pct = moneyPct(cap.spentUsd, cap.limitUsd);
  const tone = pct >= 100 ? 'red' : pct >= 90 ? 'amber' : 'green';
  const barColor =
    tone === 'red'
      ? 'var(--danger)'
      : tone === 'amber'
        ? 'var(--gold)'
        : 'var(--teal)';

  // Scale the bars against the cap so the cap line is meaningful; never clip
  // a bar that exceeds the cap.
  const peak = Math.max(cap.limitUsd, ...series.map((p) => p.v)) || 1;
  const usable = H - pad * 2;
  const n = series.length;
  const gap = 3;
  const bw = Math.max(2, (W - gap * (n - 1)) / n);
  const capY = pad + usable * (1 - cap.limitUsd / peak);

  return (
    <div className="mon-spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Spend ${cap.spentUsd} of ${cap.limitUsd} dollars`}>
        {series.map((p, i) => {
          const h = Math.max(1, usable * (p.v / peak));
          const x = i * (bw + gap);
          const y = pad + (usable - h);
          return <rect key={i} x={x} y={y} width={bw} height={h} rx={1} fill={barColor} opacity={0.85} />;
        })}
        {/* cap line */}
        <line x1={0} y1={capY} x2={W} y2={capY} stroke="var(--text-faint)" strokeWidth={1}
          strokeDasharray="4 3" />
      </svg>
      <div className="mon-spark-foot">
        <span className="mono">{cap.id}</span>
        <span>
          ${cap.spentUsd} / ${cap.limitUsd}{' '}
          <span className={tone === 'green' ? '' : `pct-${tone}`}>({pct}%)</span>
        </span>
      </div>
    </div>
  );
}
