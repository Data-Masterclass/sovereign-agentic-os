/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Node = { id: string; kind: 'version' | 'metric' | 'dashboard'; label: string; sublabel: string; built: boolean; passThrough?: boolean; columns?: string[] };
type Edge = { from: string; to: string; kind: string };
type Gate = { ok: boolean; missing: string[] };
type Graph = { dataset: string; tier: string; certification?: { level: string; by: string }; nodes: Node[]; edges: Edge[]; transparency: Gate };

/**
 * End-to-end lineage + transparency, assembled from the single source: the
 * refinement chain (Bronze→Silver→Gold, column-level), the consumption chain
 * (Gold→metric→dashboard), the trust tier, and the transparency gate — green only
 * when every artifact is documented and in the graph.
 */
export default function LineagePanel({ datasetId }: { datasetId: string }) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/lineage`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not load lineage'); return; }
      setGraph(data);
    } catch (e) { setErr((e as Error).message); }
  }, [datasetId]);
  useEffect(() => { load(); }, [load]);

  if (err) return <div className="error">{err}</div>;
  if (!graph) return <div className="stub-page">Tracing lineage…</div>;

  const versions = graph.nodes.filter((n) => n.kind === 'version');
  const metrics = graph.nodes.filter((n) => n.kind === 'metric');
  const dash = graph.nodes.find((n) => n.kind === 'dashboard');

  return (
    <div className="guided-panel">
      <div className={`gate-check ${graph.transparency.ok ? 'gate-ok' : 'gate-bad'}`} style={{ marginBottom: 14 }}>
        <strong>{graph.transparency.ok ? '✓ Transparency gate green' : 'Transparency gate — missing:'}</strong>
        {graph.transparency.ok ? <span className="muted"> every artifact documented + in the lineage graph</span> : (
          <ul className="gate-missing">{graph.transparency.missing.map((m) => <li key={m}>{m}</li>)}</ul>
        )}
      </div>

      <div className="lineage-flow">
        {versions.map((n, i) => (
          <span key={n.id} className="lineage-step">
            {i > 0 ? <span className="lineage-arrow">→</span> : null}
            <span className="lineage-node ver">
              <span className="ln-label">{n.label}{n.passThrough ? ' ·passed through' : ''}</span>
              <span className="ln-sub mono">{n.sublabel}</span>
            </span>
          </span>
        ))}
        {metrics.length ? (
          <>
            <span className="lineage-arrow">→</span>
            <span className="lineage-node metric">
              <span className="ln-label">{metrics.map((m) => m.label).join(', ')}</span>
              <span className="ln-sub">{metrics[0].sublabel}</span>
            </span>
          </>
        ) : null}
        {dash ? (
          <>
            <span className="lineage-arrow">→</span>
            <span className="lineage-node dash">
              <span className="ln-label">{dash.label}</span>
              <span className="ln-sub">{dash.sublabel}</span>
            </span>
          </>
        ) : null}
      </div>

      {versions[0]?.columns?.length ? (
        <p className="hint" style={{ marginTop: 12 }}>
          Column-level lineage: <span className="mono">{versions[0].columns.join(', ')}</span> flow through every layer.
        </p>
      ) : null}

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <span className={`badge ${graph.tier === 'product' ? 'vis-certified' : graph.tier === 'asset' ? 'vis-shared' : 'vis-personal'}`}>
          {graph.tier === 'product' ? 'Data product' : graph.tier === 'asset' ? 'Data asset' : 'Dataset'}
        </span>
        {graph.certification ? <span className={`badge cert-${graph.certification.level}`}>✦ {graph.certification.level} certified · {graph.certification.by}</span> : null}
      </div>
    </div>
  );
}
