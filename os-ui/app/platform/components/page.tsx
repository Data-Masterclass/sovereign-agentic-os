/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import GuardedConfirm from '@/components/GuardedConfirm';

type SelfHeal = { restarts: number; argoSelfHealed: boolean; state: 'healthy' | 'healing' | 'degraded'; note: string };
type Comp = { id: string; name: string; layer: string; status: string; version: string; toggle: boolean; summary: string; selfHeal: SelfHeal };
type Node = { name: string; ready: boolean; role: string; cpu: string; mem: string; pods: number };
type Pool = { name: string; min: number; max: number; current: number; autoRepair: boolean };

function statusClass(s: string): string {
  if (s === 'running') return 'b-running';
  if (s === 'starting') return 'b-starting';
  if (s === 'off' || s === 'disabled') return 'b-off';
  return 'b-unknown';
}

export default function ComponentsPage() {
  const [components, setComponents] = useState<Comp[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState<Comp | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/platform-admin/components', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else { setComponents(body.components ?? []); setNodes(body.nodes ?? []); setPools(body.pools ?? []); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(async (c: Comp, confirm?: string) => {
    setBusy(c.id); setError('');
    try {
      const res = await fetch('/api/platform-admin/components', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(confirm ? { id: c.id, confirm } : { id: c.id }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Toggle failed');
      else { setPending(null); await load(); }
    } finally { setBusy(''); }
  }, [load]);

  const onToggle = useCallback((c: Comp) => {
    const on = c.status === 'running' || c.status === 'starting';
    if (on) setPending(c); // disabling is guarded
    else toggle(c); // enabling is direct
  }, [toggle]);

  const layers = [...new Set(components.map((c) => c.layer))];

  return (
    <>
      <PageHeader title="Components & System" crumb="platform · the Admin Console (monitoring-and-healing.md)" />
      <div className="content">
        <p className="lead">
          Component <strong>up/down + versions</strong>, optional-layer enable/disable, and
          <strong> self-heal status</strong>. Kubernetes restarts crashed pods and Argo CD reverts drift
          automatically; you act only when something can’t self-heal. Toggles act on already-provisioned
          workloads only — disabling is <strong>guarded + audited</strong>. Live health & traces are in{' '}
          <Link href="/monitoring">Monitoring</Link>.
        </p>
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Cluster<span className="count-pill">{nodes.length} node</span></div>
        <div className="pa-kpis">
          {nodes.map((n) => (
            <div className="card pa-kpi" key={n.name}>
              <span className="k-label">{n.name}</span>
              <span className="k-value" style={{ fontSize: 18 }}>{n.ready ? 'Ready' : 'NotReady'}</span>
              <span className="k-sub">{n.role} · {n.cpu} cpu · {n.mem} · {n.pods} pods</span>
            </div>
          ))}
          {pools.map((p) => (
            <div className="card pa-kpi" key={p.name}>
              <span className="k-label">Pool · {p.name}</span>
              <span className="k-value" style={{ fontSize: 18 }}>{p.current} / {p.min}–{p.max}</span>
              <span className="k-sub">{p.autoRepair ? 'auto-repair on' : 'auto-repair off'}</span>
            </div>
          ))}
        </div>

        {loading && components.length === 0 ? <div className="stub-page">Loading components…</div> : null}

        {layers.map((layer) => (
          <div key={layer}>
            <div className="section-title" style={{ marginTop: 18 }}>{layer}</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Component</th><th>Version</th><th>Status</th><th>Self-heal</th><th></th></tr></thead>
                <tbody>
                  {components.filter((c) => c.layer === layer).map((c) => {
                    const on = c.status === 'running' || c.status === 'starting';
                    return (
                      <tr key={c.id}>
                        <td><strong>{c.name}</strong><div className="muted" style={{ fontSize: 11 }}>{c.summary}</div></td>
                        <td className="mono" style={{ fontSize: 12 }}>{c.version}</td>
                        <td><span className={`comp-dot ${statusClass(c.status)}`} style={{ display: 'inline-block', marginRight: 6 }} />{c.status}</td>
                        <td>
                          <span className={`badge ${c.selfHeal.state === 'healthy' ? 'ok' : c.selfHeal.state === 'healing' ? 'muted' : 'err'}`}>{c.selfHeal.state}</span>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {c.selfHeal.restarts > 0 ? `${c.selfHeal.restarts} restart(s)` : 'no restarts'}{c.selfHeal.argoSelfHealed ? ' · Argo reverted drift' : ''}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {c.toggle ? (
                            <button className={`switch${on ? ' on' : ''}`} disabled={busy === c.id} onClick={() => onToggle(c)} style={{ marginLeft: 'auto' }}>
                              <span className="switch-track"><span className="switch-thumb" /></span>
                              <span className="switch-text">{on ? 'On' : 'Off'}</span>
                            </button>
                          ) : <span className="pa-tag">core</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      <GuardedConfirm
        open={!!pending}
        title={pending ? `Disable ${pending.name}?` : ''}
        phrase={pending ? `disable ${pending.id}` : ''}
        detail={pending ? `Scales ${pending.name} to zero. Dependent flows will degrade until it is re-enabled.` : ''}
        confirmLabel="Disable"
        busy={busy === pending?.id}
        onConfirm={() => pending && toggle(pending, `disable ${pending.id}`)}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
