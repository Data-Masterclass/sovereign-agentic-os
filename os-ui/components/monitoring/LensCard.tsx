/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { HealthItem, LensSummary } from '@/lib/monitoring';
import { healthDot, isRun } from './health';
import CostSparkline from './CostSparkline';

/**
 * One lens card: label + roll-up dot + per-health counts, then its items
 * (already sorted worst-first by the spine). Run items are buttons that drill
 * into the trace drawer; everything else is a quiet row. Cost items render an
 * inline spend sparkline. Greens recede — no full-card colour fills.
 */
export default function LensCard({
  lens,
  onOpen,
}: {
  lens: LensSummary;
  onOpen: (item: HealthItem) => void;
}) {
  const c = lens.counts;
  return (
    <div className="card comp-card">
      <div className="mon-lens-head">
        <span className={healthDot(lens.health)} />
        <span className="mon-lens-label">{lens.label}</span>
        <span className="mon-counts">
          {c.red > 0 && <span className="c-red"><b>{c.red}</b> red</span>}
          {c.amber > 0 && <span className="c-amber"><b>{c.amber}</b> amber</span>}
          <span className="c-green"><b>{c.green}</b> green</span>
          {c.unknown > 0 && <span><b>{c.unknown}</b> ?</span>}
        </span>
      </div>

      <div className="mon-items">
        {lens.items.length === 0 ? (
          <div className="mon-item-detail" style={{ padding: '6px 8px' }}>
            Nothing in scope.
          </div>
        ) : (
          lens.items.map((it) => {
            const drillable = isRun(it.lens, it.links?.runId) || it.health !== 'green';
            const Row = drillable ? 'button' : 'div';
            return (
              <Row
                key={it.id}
                className="mon-item"
                {...(drillable ? { type: 'button' as const, onClick: () => onOpen(it) } : {})}
              >
                <span className={healthDot(it.health)} />
                <span className="mon-item-body">
                  <span className="mon-item-title">
                    {it.title}
                    {it.source === 'mock' && <span className="mon-tag">mock</span>}
                  </span>
                  <span className="mon-item-detail">{it.detail}</span>
                  {it.lens === 'cost' && <CostSparkline item={it} />}
                </span>
                {isRun(it.lens, it.links?.runId) ? (
                  <span className="mon-drill">trace →</span>
                ) : drillable ? (
                  <span className="mon-drill">chain →</span>
                ) : null}
              </Row>
            );
          })
        )}
      </div>
    </div>
  );
}
