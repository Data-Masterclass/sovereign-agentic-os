/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { HealthItem } from '@/lib/monitoring';
import { healthDot, LENS_SHORT } from './health';

/**
 * Attention-first: the few red/amber items, prominent, at the very top. When
 * empty we show a small, calm "All clear" line — never a giant green wall.
 * Each card opens the trace/chain drawer.
 */
export default function AttentionStrip({
  items,
  onOpen,
}: {
  items: HealthItem[];
  onOpen: (item: HealthItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="mon-allclear">
        <span className={healthDot('green')} />
        All clear — nothing in your scope needs attention.
      </div>
    );
  }

  return (
    <div className="mon-attn-grid">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={`mon-attn clickable h-${it.health}`}
          onClick={() => onOpen(it)}
        >
          <span className="mon-attn-head">
            <span className={healthDot(it.health)} />
            <span className="mon-attn-title">{it.title}</span>
            <span className="mon-tag" style={{ marginLeft: 'auto' }}>
              {LENS_SHORT[it.lens]}
            </span>
          </span>
          <span className="mon-attn-detail">{it.detail}</span>
        </button>
      ))}
    </div>
  );
}
