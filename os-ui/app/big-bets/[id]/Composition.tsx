/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { type BetView } from '../types';

/**
 * Composition map — the "builds on" graph (distinct from the roadmap's
 * build-order dependencies). Each node lists what it builds on; upstream nodes
 * are flagged, and the OpenMetadata FQN is shown as a lineage reference.
 */
export default function Composition({ view }: { view: BetView }) {
  const { nodes, edges } = view.composition;
  if (nodes.length === 0) {
    return <div className="hint">No composition recorded yet — it fills in as components declare what they build on.</div>;
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const buildsOn = new Map<string, string[]>();
  for (const e of edges) {
    const arr = buildsOn.get(e.from) ?? [];
    arr.push(e.to);
    buildsOn.set(e.from, arr);
  }

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        The builds-on graph — distinct from the roadmap&rsquo;s build-order dependencies. Upstream
        artifacts are reused across bets; their OpenMetadata FQN is the lineage reference.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {nodes.map((n) => {
          const deps = (buildsOn.get(n.id) ?? []).map((id) => nodeMap.get(id)?.title ?? id);
          return (
            <div key={n.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 14px', background: 'var(--panel)' }}>
              <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{n.title}</span>
                <span className="chip">{n.tab}</span>
                {n.upstream ? <span className="badge muted">upstream</span> : null}
                {n.omFqn ? <span className="mono muted" style={{ fontSize: 10.5 }} title="OpenMetadata FQN">{n.omFqn}</span> : null}
              </div>
              {deps.length ? (
                <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>↳ builds on {deps.join(', ')}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
