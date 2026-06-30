/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { WorkflowSummary } from '@/lib/knowledge/store';

/**
 * A single workflow tile in the Knowledge tab grid. Shows title, actor mix
 * (colored badges), publish state, and a primary action. Clicking the tile
 * opens the WorkflowView editor.
 */

type Props = {
  workflow: WorkflowSummary;
  onClick: (id: string) => void;
};

const STATUS_LABEL: Record<string, string> = { draft: 'Draft', live: 'Live' };
const VIS_CLASS: Record<string, string> = {
  Personal: 'vis-personal',
  Shared: 'vis-shared',
  Marketplace: 'vis-certified',
};

export default function WorkflowTile({ workflow: w, onClick }: Props) {
  return (
    <button
      className="workflow-tile"
      onClick={() => onClick(w.id)}
      aria-label={`Open workflow: ${w.title}`}
    >
      <div className="workflow-tile-head">
        <span className="workflow-tile-title">{w.title}</span>
        <span className={`badge ${VIS_CLASS[w.visibility] ?? 'muted'}`}>
          {w.visibility}
        </span>
      </div>
      <div className="workflow-tile-meta">
        <span className={`badge ${w.status === 'live' ? 'ok' : 'muted'}`}>
          {STATUS_LABEL[w.status] ?? w.status}
        </span>
        {w.publishedBy && (
          <span className="muted" style={{ fontSize: 11 }}>
            published by {w.publishedBy}
          </span>
        )}
      </div>
    </button>
  );
}
