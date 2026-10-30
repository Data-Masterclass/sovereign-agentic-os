/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        admin
 * FEATURE:    Overview & Health — the tenant cockpit MERGED with Components & System, one Platform tab
 * USER STORY: As a platform admin I want one tab that answers "is this tenant healthy and within
 *             budget, and what is actually running" — because the old Overview and Components &
 *             System both answered half of that, and I had to read both.
 * ARCHITECTURE:
 *   - A 2026-10-30 MERGE, not a redesign: the cockpit (KPIs, open alerts, recent audit) comes from
 *     app/(govern)/platform/page.tsx and everything below it — cluster, platform services, system
 *     health, the dependency chain and the component tables with their toggles — comes verbatim from
 *     app/(govern)/platform/components/page.tsx. That route is now a redirect to
 *     /platform?section=overview.
 *   - ROLE SPLIT, deliberately NOT the stricter of the two: Overview was minRole 'builder' and
 *     Components & System was 'admin'. Merging at 'admin' would have left a builder a Platform tab
 *     with nothing in it, so this tab is builder-READABLE (it renders for a builder) while every
 *     ACTION — enable/disable a component, the guarded confirm — needs OVERVIEW_ACTION_MIN_ROLE
 *     ('admin'). A builder is shown the surface and where their own signals live; they are NOT shown
 *     component rows, because every status endpoint (/api/platform-admin/overview and
 *     /api/platform-admin/components) is adminCtx()-gated server-side and widening that would have
 *     widened access, which this restructure forbids.
 *   - Fail closed twice: nothing renders until useUser() resolves a role (never a flash), and the
 *     admin body — which holds every hook and every fetch — is not mounted for a non-admin, so a
 *     builder's browser never even asks for the admin aggregate.
 *   - One gateway panel, not two: both pages carried a GatewayPanel over the same
 *     /api/platform-admin/gateway mirror. The 'overview' variant is kept because it alone lists the
 *     UNMANAGED gateway rows.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import GuardedConfirm from '@core/ui/GuardedConfirm';
import { useApi } from '@core/ui/useApi';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { OVERVIEW_ACTION_MIN_ROLE, sectionMinRole } from '@tabs/admin/lib/sections';
import GatewayPanel from '@tabs/admin/ui/GatewayPanel';

/** The admin cockpit aggregate — carried over from the old /platform page. */
type Cockpit = {
  tenant: { id: string; name: string; residency: string; plan: string };
  opa: string;
  health: { total: number; running: number; source: string };
  counts: { domains: number; domainsActive: number; users: number; usersActive: number; admins: number };
  billing: { envelopeEUR: number; spendEUR: number; pctUsed: number; hardStop: boolean };
  policy: { principals: number; tools: string[]; bundle: string; publish: { status: string; detail: string } };
  alerts: { level: 'warn' | 'info'; text: string; href: string }[];
  recentAudit: { id: string; ts: string; actor: string; action: string; detail: string }[];
};

type SelfHeal = { restarts: number; argoSelfHealed: boolean; state: 'healthy' | 'healing' | 'degraded'; note: string };
type Comp = { id: string; name: string; layer: string; status: string; version: string; toggle: boolean; summary: string; selfHeal: SelfHeal };
type Node = { name: string; ready: boolean; role: string; cpu: string; mem: string; pods: number };
type Pool = { name: string; min: number; max: number; current: number; autoRepair: boolean };
type ServiceProbe = { key: string; label: string; up: boolean; detail: string };
type Health = 'red' | 'amber' | 'green' | 'unknown';
type SysItem = { id: string; title: string; health: Health; detail: string; selfHeal?: string; source: 'live' | 'mock' };
type Hop = { lens: string; title: string; health: Health };
type Chain = {
  anchor: string;
  run?: { title: string; health: Health };
  pipeline?: { title: string; health: Health };
  system?: { title: string; health: Health };
  artifact?: { title: string; health: Health };
} | null;

function statusClass(s: string): string {
  if (s === 'running' || s === 'on-demand') return 'b-running';
  if (s === 'starting') return 'b-starting';
  if (s === 'off' || s === 'stopped' || s === 'disabled') return 'b-off';
  return 'b-unknown';
}

/** Not-deployed-at-all (no workload) vs deployed-but-stopped (scaled to zero). */
const NOT_DEPLOYED = new Set(['unknown', 'disabled', 'n/a']);
function statusLabel(s: string): string {
  return NOT_DEPLOYED.has(s) ? 'not deployed' : s;
}

/** Health roll-up → the existing badge palette. */
function healthBadge(h: Health): string {
  const map: Record<Health, string> = { red: 'err', amber: 'warn', green: 'ok', unknown: 'muted' };
  return `badge ${map[h]}`;
}

const LENS_LABEL: Record<string, string> = { runs: 'Run', pipelines: 'Pipeline', system: 'System', artifacts: 'Artifact' };

export default function OverviewHealth() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  // Fail closed: render nothing at all until the role resolves and clears the
  // tab's own floor ('builder'); never flash platform content at a creator.
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('overview'))) return null;
  // The admin body holds every hook and every fetch, so a builder's browser
  // never asks for an aggregate it may not have.
  if (!roleAtLeast(role, OVERVIEW_ACTION_MIN_ROLE)) return <BuilderOverview />;
  return <AdminOverviewHealth />;
}

/**
 * What a builder sees. Tenant configuration is a platform admin's job, and every
 * component-status read is adminCtx()-gated, so this is honest about the boundary
 * instead of rendering an empty table or a 403.
 */
function BuilderOverview() {
  return (
    <div>
      <p className="lead">
        Tenant configuration — identity, users, models, domains, backups — is managed by a{' '}
        <strong>platform admin</strong>, and component status is admin-only. Your own domain roles and
        approvals live in <Link href="/governance">Governance</Link>; your runs, spend and the health
        signals for your own work are in <Link href="/monitoring">Monitoring</Link>.
      </p>
      <div className="hint">
        Nothing here needs you. If you think it does, ask a platform admin for the role.
      </div>
    </div>
  );
}

function AdminOverviewHealth() {
  const [components, setComponents] = useState<Comp[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [services, setServices] = useState<ServiceProbe[]>([]);
  const [servicesSummary, setServicesSummary] = useState<{ up: number; total: number } | null>(null);
  const [systemHealth, setSystemHealth] = useState<SysItem[]>([]);
  const [chain, setChain] = useState<Chain>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [pending, setPending] = useState<Comp | null>(null);
  // The cockpit half of the merge. adminCtx-gated, and only this (admin-only)
  // component mounts it.
  const { data: cockpit, loading: cockpitLoading, error: cockpitError, reload: reloadCockpit } =
    useApi<Cockpit>('/api/platform-admin/overview');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/platform-admin/components', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else {
        setComponents(body.components ?? []);
        setNodes(body.nodes ?? []);
        setPools(body.pools ?? []);
        setServices(body.services ?? []);
        setServicesSummary(body.servicesSummary ?? null);
        setSystemHealth(body.systemHealth ?? []);
        setChain(body.chain ?? null);
      }
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

  const hops: Hop[] = chain
    ? ([
        ['runs', chain.run],
        ['pipelines', chain.pipeline],
        ['system', chain.system],
        ['artifacts', chain.artifact],
      ].filter(([, v]) => Boolean(v)) as [string, { title: string; health: Health }][]).map(([lens, v]) => ({
        lens, title: v.title, health: v.health,
      }))
    : [];

  return (
    <>
      <div>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            The tenant cockpit. Platform <strong>configures</strong> structure, identity, models and
            posture; <Link href="/governance">Governance</Link> enforces &amp; sees it, <Link href="/monitoring">Monitoring</Link>{' '}
            watches live spend. Every action here is audited.
          </p>
          <button className="btn ghost" onClick={reloadCockpit} disabled={cockpitLoading}>{cockpitLoading ? <span className="spin" /> : 'Refresh'}</button>
        </div>

        {cockpitError ? <div className="error" style={{ marginTop: 18 }}>{cockpitError}</div> : null}

        {cockpit ? (
          <>
            <div className="pa-kpis" style={{ marginTop: 18 }}>
              <div className="card pa-kpi">
                <span className="k-label">Component health</span>
                <span className="k-value">{cockpit.health.running}/{cockpit.health.total}</span>
                <span className="k-sub">{cockpit.health.source === 'live' ? 'running · live cluster' : 'registry · offline'}</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Spend vs envelope</span>
                <span className="k-value">{cockpit.billing.pctUsed}%</span>
                <div className={`pa-bar${cockpit.billing.hardStop ? ' stop' : cockpit.billing.pctUsed >= 80 ? ' warn' : ''}`}>
                  <span style={{ width: `${Math.min(100, cockpit.billing.pctUsed)}%` }} />
                </div>
                <span className="k-sub">€{cockpit.billing.spendEUR} / €{cockpit.billing.envelopeEUR} per mo</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Users</span>
                <span className="k-value">{cockpit.counts.usersActive}</span>
                <span className="k-sub">{cockpit.counts.admins} admin · {cockpit.counts.users} total</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Domains</span>
                <span className="k-value">{cockpit.counts.domainsActive}</span>
                <span className="k-sub">{cockpit.counts.domains} incl. archived</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Compiled to OPA</span>
                <span className="k-value">{cockpit.policy.principals}</span>
                <span className="k-sub">principals · {cockpit.policy.tools.length} tools · {cockpit.policy.publish.status}</span>
              </div>
            </div>

            <div className="section-title">Open admin alerts{cockpit.alerts.length ? <span className="count-pill">{cockpit.alerts.length}</span> : null}</div>
            {cockpit.alerts.length === 0 ? (
              <div className="hint">Nothing needs you. Health green, spend within envelope.</div>
            ) : (
              cockpit.alerts.map((a, i) => (
                <Link key={i} href={a.href} className={`pa-alert ${a.level}`}>
                  <span className="dot" />{a.text}<span className="golden" style={{ border: 'none', background: 'none', marginLeft: 'auto', padding: 0 }}>→</span>
                </Link>
              ))
            )}
          </>
        ) : cockpitLoading ? <div className="stub-page" style={{ marginTop: 20 }}>Loading cockpit…</div> : null}

        <div className="section-title" style={{ marginTop: 22 }}>Components &amp; system</div>
        <p className="lead">
          The single home for the stack&apos;s infrastructure: component <strong>up/down + versions</strong>,
          optional-layer enable/disable, <strong>self-heal</strong>, the <strong>platform services</strong> the
          control plane is wired to, and <strong>system &amp; cluster health</strong> with the dependency/impact
          chain. Kubernetes restarts crashed pods and Argo CD reverts drift automatically; you act only when
          something can&apos;t self-heal. Your agents&apos; runs, spend and traces are in{' '}
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

        {/* ---- Platform services (moved from Connections) ---- */}
        <div className="section-title">
          Platform services
          {servicesSummary ? (
            <span className={`count-pill${servicesSummary.up === servicesSummary.total ? ' ok' : ' warn'}`}>
              {servicesSummary.up}/{servicesSummary.total} reachable
            </span>
          ) : null}
        </div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          Internal control-plane backends the stack is wired to (gateway, policy, retrieval, observability…).
          External systems agents use as tools live in <Link href="/connections">Connections</Link>.
        </p>
        {services.length === 0 ? (
          <div className="stub-page">No platform-service reads — the control plane isn&apos;t reachable from here yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Service</th><th>Probe</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.key}>
                    <td style={{ fontWeight: 600 }}>{s.label}</td>
                    <td className="mono">{s.key}</td>
                    <td><span className={`badge ${s.up ? 'ok' : 'err'}`}>{s.up ? 'reachable' : 'down'}</span></td>
                    <td className="muted">{s.up ? 'up' : s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ---- System & cluster health (moved from Monitoring) ---- */}
        <div className="section-title" style={{ marginTop: 18 }}>System &amp; cluster health</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          Node/pod/service signals + self-heal (Kubernetes restarts, Argo CD drift revert, node auto-repair).
        </p>
        {systemHealth.length === 0 ? (
          <div className="stub-page">No system signals — not reachable in this release.</div>
        ) : (
          <div className="grid">
            {systemHealth.map((s) => (
              <div className="card comp-card" key={s.id}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{s.title}</strong>
                  <span className={healthBadge(s.health)}>{s.health}</span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{s.detail}</div>
                {s.selfHeal ? <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>↻ {s.selfHeal}</div> : null}
                {s.source === 'mock' ? <span className="pa-tag" style={{ marginTop: 8 }}>mock</span> : null}
              </div>
            ))}
          </div>
        )}

        {/* ---- Dependency / impact chain (moved from Monitoring) ---- */}
        {hops.length > 1 ? (
          <>
            <div className="section-title" style={{ marginTop: 18 }}>Dependency &amp; impact chain</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              How the latest infrastructure signal propagated — from the infra event to the pipeline, run and
              artifact it touched. Read-only; the run trace itself lives in <Link href="/monitoring">Monitoring</Link>.
            </p>
            <div className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 0 }}>
              {hops.map((h, i) => (
                <div key={h.lens} style={{ display: 'flex', alignItems: 'center' }}>
                  {i > 0 ? <span className="muted" style={{ margin: '0 14px', fontSize: 18 }}>→</span> : null}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                    <span className="mono muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
                      {LENS_LABEL[h.lens] ?? h.lens}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                      <span className={healthBadge(h.health)} style={{ padding: '1px 6px' }}>{h.health}</span>
                      {h.title}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

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
                    const notDeployed = NOT_DEPLOYED.has(c.status);
                    return (
                      <tr key={c.id}>
                        <td><strong>{c.name}</strong><div className="muted" style={{ fontSize: 11 }}>{c.summary}</div></td>
                        <td className="mono" style={{ fontSize: 12 }}>{c.version}</td>
                        <td><span className={`comp-dot ${statusClass(c.status)}`} style={{ display: 'inline-block', marginRight: 6 }} />{statusLabel(c.status)}</td>
                        <td>
                          <span className={`badge ${c.selfHeal.state === 'healthy' ? 'ok' : c.selfHeal.state === 'healing' ? 'muted' : 'err'}`}>{c.selfHeal.state}</span>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {c.selfHeal.restarts > 0 ? `${c.selfHeal.restarts} restart(s)` : 'no restarts'}{c.selfHeal.argoSelfHealed ? ' · Argo reverted drift' : ''}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {!c.toggle ? (
                            <span className="pa-tag">core</span>
                          ) : notDeployed ? (
                            <span className="pa-tag" title="No workload provisioned — enable it in a release, not from here.">enable in a release</span>
                          ) : (
                            <button className={`switch${on ? ' on' : ''}`} disabled={busy === c.id} onClick={() => onToggle(c)} style={{ marginLeft: 'auto' }}>
                              <span className="switch-track"><span className="switch-thumb" /></span>
                              <span className="switch-text">{on ? 'On' : 'Off'}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        <div className="section-title" style={{ marginTop: 22 }}>
          Recent audit
          <Link href="/governance" className="hint" style={{ marginLeft: 10, textTransform: 'none', letterSpacing: 0 }}>full record in Governance →</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {!cockpit || cockpit.recentAudit.length === 0 ? (
                <tr><td colSpan={4} className="muted">No actions yet this session.</td></tr>
              ) : cockpit.recentAudit.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ fontSize: 11.5 }}>{new Date(e.ts).toLocaleString()}</td>
                  <td><strong>{e.actor}</strong></td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.action}</td>
                  <td style={{ whiteSpace: 'normal' }}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

      {/* One panel for the merged tab: the 'overview' variant alone lists the
          UNMANAGED gateway rows, and both variants read the same mirror. */}
      <GatewayPanel variant="overview" />
    </>
  );
}
