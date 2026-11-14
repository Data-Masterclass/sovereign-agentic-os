/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { WorkflowSummary } from '@tabs/knowledge/lib/store';
import DomainTag from '@core/ui/DomainTag';

/**
 * A single workflow tile in the Knowledge tab grid. Shows title, actor mix
 * (colored badges), publish state, and a primary action. Clicking the tile
 * opens the WorkflowView editor.
 */

type Props = {
  workflow: WorkflowSummary;
  onClick: (id: string) => void;
};

// NOTE (night 2, stream V): this tile already renders its OWN Draft/Live badge, from the
// workflow's `status` (published to the search index or not). That is a DIFFERENT fact from the
// lifecycle pin, and showing two badges with the same two words would be exactly the vocabulary
// collision the simplicity contract forbids — so the lifecycle badge is deliberately NOT mounted
// here. The Studio|Run FILTER is applied to the grid (app/(plan)/workflows/page.tsx). Reconciling
// the two — making `status` BE the lifecycle — is a Knowledge-tab change; see deviation V-12.
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', live: 'Live' };
const VIS_CLASS: Record<string, string> = {
  Personal: 'vis-personal',
  Shared: 'vis-shared',
  Marketplace: 'vis-certified',
};
// Display labels from the OS-wide scope vocabulary (lib/core/scopes.ts):
// Shared→Domain, Marketplace→Company. Keys stay the persisted visibility values.
const VIS_LABEL: Record<string, string> = {
  Personal: 'My',
  Shared: 'Domain',
  Marketplace: 'Company',
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
          {VIS_LABEL[w.visibility] ?? w.visibility}
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
        {/* Source-domain provenance in Shared/Marketplace scopes (renders nothing otherwise). */}
        {(w.visibility === 'Shared' || w.visibility === 'Marketplace') && <DomainTag domain={w.domain} />}
      </div>
    </button>
  );
}
