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
 *   - I18N:       converted (wave 2) — texts from `admin.overview.*`. Component names, layers, versions, alert and
 *     audit texts and every status note come from the server and render as they are.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useFormat } from '@core/i18n/client';
import GuardedConfirm from '@core/ui/GuardedConfirm';
import { useApi } from '@core/ui/useApi';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { OVERVIEW_ACTION_MIN_ROLE, sectionMinRole } from '@tabs/admin/lib/sections';
import { nodeListNotice } from '@tabs/admin/lib/node-list-notice';
import GatewayPanel from '@tabs/admin/ui/GatewayPanel';
import SystemKeysPanel from '@tabs/admin/ui/SystemKeysPanel';

/** The admin cockpit aggregate — carried over from the old /platform page. */
type Cockpit = {
  tenant: { id: string; name: string; residency: string; plan: string };
  opa: string;
  health: { total: number; running: number; source: string };
  counts: { domains: number; domainsActive: number; users: number; usersActive: number; admins: number };
  // Null figures when spend could not be read (review H1) — never 0, which would read as
  // "nothing spent". The tile shows an em dash instead.
  billing: { envelopeEUR: number; spendEUR: number | null; pctUsed: number | null; hardStop: boolean };
  policy: { principals: number; tools: string[]; bundle: string; publish: { status: string; detail: string } };
  alerts: { level: 'warn' | 'info'; text: string; href: string }[];
  recentAudit: { id: string; ts: string; actor: string; action: string; detail: string }[];
};

// Live readings (tabs/admin/lib/component-health.ts, cluster-nodes.ts): versions from each component's
// own endpoint, restarts from its pods, nodes from the Kubernetes API — never typed in.
type SelfHeal = { restarts: number; state: 'healthy' | 'healing' | 'degraded' | 'unknown'; note: string };
type Comp = { id: string; name: string; layer: string; status: string; version: string | null; versionSource: 'component' | 'image' | 'none'; versionNote: string; toggle: boolean; summary: string; selfHeal: SelfHeal };
type Node = { name: string; ready: boolean; roles: string; pool: string | null; cpu: string; mem: string; kubelet: string };
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
/** Catalog leaf per known component status (`admin.overview.status.*`); an unknown status renders as sent. */
const STATUS_KEY = { running: 'running', starting: 'starting', 'on-demand': 'onDemand', off: 'off', stopped: 'stopped' } as const;
type T = ReturnType<typeof useTranslations<'admin'>>;
function statusLabel(s: string, t: T): string {
  if (NOT_DEPLOYED.has(s)) return t('overview.status.notDeployed');
  const k = STATUS_KEY[s as keyof typeof STATUS_KEY];
  return k ? t(`overview.status.${k}`) : s;
}

/** The audit row's date exactly as `toLocaleString()` wrote it in English, in the active language. */
const LEGACY_DT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
/** Euro amounts exactly as the old `€${n}` wrote them in English (no grouping, no padded decimals). */
const EUR: Intl.NumberFormatOptions = { minimumFractionDigits: 0, maximumFractionDigits: 20, useGrouping: false };

/** Health roll-up → the existing badge palette. */
function healthBadge(h: Health): string {
  const map: Record<Health, string> = { red: 'err', amber: 'warn', green: 'ok', unknown: 'muted' };
  return `badge ${map[h]}`;
}

type Lens = 'runs' | 'pipelines' | 'system' | 'artifacts';
const LENSES: ReadonlySet<string> = new Set<Lens>(['runs', 'pipelines', 'system', 'artifacts']);
function lensLabel(lens: string, t: T): string {
  return LENSES.has(lens) ? t(`overview.lens.${lens as Lens}`) : lens;
}

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
  const t = useTranslations('admin');
  return (
    <div>
      <p className="lead">
        {t.rich('overview.builder.lead', {
          strong: (c) => <strong>{c}</strong>,
          gov: (c) => <Link href="/governance">{c}</Link>,
          mon: (c) => <Link href="/monitoring">{c}</Link>,
        })}
      </p>
      <div className="hint">
        {t('overview.builder.hint')}
      </div>
    </div>
  );
}

function AdminOverviewHealth() {
  const t = useTranslations('admin');
  const f = useFormat();
  const [components, setComponents] = useState<Comp[]>([]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [nodesError, setNodesError] = useState<{ reason: string; detail: string } | null>(null);
  const [nodesOff, setNodesOff] = useState(false);
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
      if (!res.ok) setError(body.error ?? t('overview.loadFailed'));
      else {
        setComponents(body.components ?? []);
        setNodes(body.nodes ?? []);
        setNodesError(body.nodesError ?? null);
        setNodesOff(body.nodesOff === true);
        setServices(body.services ?? []);
        setServicesSummary(body.servicesSummary ?? null);
        setSystemHealth(body.systemHealth ?? []);
        setChain(body.chain ?? null);
      }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(async (c: Comp, confirm?: string) => {
    setBusy(c.id); setError('');
    try {
      const res = await fetch('/api/platform-admin/components', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(confirm ? { id: c.id, confirm } : { id: c.id }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('overview.toggleFailed'));
      else { setPending(null); await load(); }
    } finally { setBusy(''); }
  }, [load, t]);

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
        <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
          <button className="btn ghost" onClick={reloadCockpit} disabled={cockpitLoading}>{cockpitLoading ? <span className="spin" /> : t('overview.refresh')}</button>
        </div>

        {cockpitError ? <div className="error" style={{ marginTop: 18 }}>{cockpitError}</div> : null}

        {cockpit ? (
          <>
            <div className="pa-kpis" style={{ marginTop: 18 }}>
              <div className="card pa-kpi">
                <span className="k-label">{t('overview.kpi.health')}</span>
                <span className="k-value">{cockpit.health.running}/{cockpit.health.total}</span>
                <span className="k-sub">{cockpit.health.source === 'live' ? t('overview.kpi.healthLive') : t('overview.kpi.healthOffline')}</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">{t('overview.kpi.spend')}</span>
                <span className="k-value">{cockpit.billing.pctUsed === null ? '—' : t('overview.kpi.pct', { pct: cockpit.billing.pctUsed })}</span>
                <div className={`pa-bar${cockpit.billing.hardStop ? ' stop' : (cockpit.billing.pctUsed ?? 0) >= 80 ? ' warn' : ''}`}>
                  <span style={{ width: `${Math.min(100, cockpit.billing.pctUsed ?? 0)}%` }} />
                </div>
                <span className="k-sub">
                  {cockpit.billing.spendEUR === null
                    ? t('overview.kpi.spendUnreadable', { envelope: f.currency(cockpit.billing.envelopeEUR, 'EUR', EUR) })
                    : t('overview.kpi.spendLine', { spend: f.currency(cockpit.billing.spendEUR, 'EUR', EUR), envelope: f.currency(cockpit.billing.envelopeEUR, 'EUR', EUR) })}
                </span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">{t('overview.kpi.users')}</span>
                <span className="k-value">{cockpit.counts.usersActive}</span>
                <span className="k-sub">{t('overview.kpi.usersSub', { admins: cockpit.counts.admins, users: cockpit.counts.users })}</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">{t('overview.kpi.domains')}</span>
                <span className="k-value">{cockpit.counts.domainsActive}</span>
                <span className="k-sub">{t('overview.kpi.domainsSub', { domains: cockpit.counts.domains })}</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">{t('overview.kpi.opa')}</span>
                <span className="k-value">{cockpit.policy.principals}</span>
                <span className="k-sub">{t('overview.kpi.opaSub', { tools: cockpit.policy.tools.length, status: cockpit.policy.publish.status })}</span>
              </div>
            </div>

            <div className="section-title">{t('overview.alertsTitle')}{cockpit.alerts.length ? <span className="count-pill">{cockpit.alerts.length}</span> : null}</div>
            {cockpit.alerts.length === 0 ? (
              <div className="hint">{t('overview.alertsNone')}</div>
            ) : (
              cockpit.alerts.map((a, i) => (
                <Link key={i} href={a.href} className={`pa-alert ${a.level}`}>
                  <span className="dot" />{a.text}<span className="golden" style={{ border: 'none', background: 'none', marginLeft: 'auto', padding: 0 }}>→</span>
                </Link>
              ))
            )}
          </>
        ) : cockpitLoading ? <div className="stub-page" style={{ marginTop: 20 }}>{t('overview.loadingCockpit')}</div> : null}

        <div className="section-title" style={{ marginTop: 22 }}>{t('overview.componentsTitle')}</div>
        <p className="lead">
          {t.rich('overview.componentsLead', { strong: (c) => <strong>{c}</strong> })}
        </p>
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">{t('overview.clusterTitle')}{nodesOff ? null : <span className="count-pill">{t('overview.nodeCount', { count: nodes.length })}</span>}</div>
        {(() => {
          // Off by config → a neutral grey note; on and unreadable → red (tabs/admin/lib/node-list-notice.ts).
          const notice = nodeListNotice({ nodesOff, nodesError });
          if (!notice) return null;
          // The tone decides; the words are the catalog's (the notice's `text` is the English).
          return notice.tone === 'error' && nodesError
            ? <div className="error">{t('overview.nodesNotReadable', { reason: nodesError.reason, detail: nodesError.detail })}</div>
            : <div className="hint" style={{ marginTop: 0 }}>{t('overview.nodesOff')}</div>;
        })()}
        <div className="pa-kpis">
          {nodes.map((n) => (
            <div className="card pa-kpi" key={n.name}>
              <span className="k-label">{n.name}</span>
              <span className="k-value" style={{ fontSize: 18 }}>{n.ready ? t('overview.nodeReady') : t('overview.nodeNotReady')}</span>
              <span className="k-sub">{n.pool
                ? t('overview.nodeSubPool', { roles: n.roles, pool: n.pool, cpu: n.cpu, mem: n.mem, kubelet: n.kubelet })
                : t('overview.nodeSub', { roles: n.roles, cpu: n.cpu, mem: n.mem, kubelet: n.kubelet })}</span>
            </div>
          ))}
        </div>

        {/* ---- Platform services (moved from Connections) ---- */}
        <div className="section-title">
          {t('overview.servicesTitle')}
          {servicesSummary ? (
            <span className={`count-pill${servicesSummary.up === servicesSummary.total ? ' ok' : ' warn'}`}>
              {t('overview.servicesReachable', { up: servicesSummary.up, total: servicesSummary.total })}
            </span>
          ) : null}
        </div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          {t.rich('overview.servicesHint', { conn: (c) => <Link href="/connections">{c}</Link> })}
        </p>
        {services.length === 0 ? (
          <div className="stub-page">{t('overview.servicesNone')}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>{t('overview.servicesCol.service')}</th><th>{t('overview.servicesCol.probe')}</th><th>{t('overview.servicesCol.status')}</th><th>{t('overview.servicesCol.detail')}</th></tr></thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.key}>
                    <td style={{ fontWeight: 600 }}>{s.label}</td>
                    <td className="mono">{s.key}</td>
                    <td><span className={`badge ${s.up ? 'ok' : 'err'}`}>{s.up ? t('overview.serviceReachable') : t('overview.serviceDown')}</span></td>
                    <td className="muted">{s.up ? t('overview.serviceUp') : s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ---- System & cluster health (moved from Monitoring) ---- */}
        <div className="section-title" style={{ marginTop: 18 }}>{t('overview.systemTitle')}</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          {t('overview.systemHint')}
        </p>
        {systemHealth.length === 0 ? (
          <div className="stub-page">{t('overview.systemNone')}</div>
        ) : (
          <div className="grid">
            {systemHealth.map((s) => (
              <div className="card comp-card" key={s.id}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{s.title}</strong>
                  <span className={healthBadge(s.health)}>{t(`overview.health.${s.health}`)}</span>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{s.detail}</div>
                {s.selfHeal ? <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>↻ {s.selfHeal}</div> : null}
                {s.source === 'mock' ? <span className="pa-tag" style={{ marginTop: 8 }}>{t('overview.mock')}</span> : null}
              </div>
            ))}
          </div>
        )}

        {/* ---- Dependency / impact chain (moved from Monitoring) ---- */}
        {hops.length > 1 ? (
          <>
            <div className="section-title" style={{ marginTop: 18 }}>{t('overview.chainTitle')}</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              {t.rich('overview.chainHint', { mon: (c) => <Link href="/monitoring">{c}</Link> })}
            </p>
            <div className="card" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 0 }}>
              {hops.map((h, i) => (
                <div key={h.lens} style={{ display: 'flex', alignItems: 'center' }}>
                  {i > 0 ? <span className="muted" style={{ margin: '0 14px', fontSize: 18 }}>→</span> : null}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                    <span className="mono muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
                      {lensLabel(h.lens, t)}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                      <span className={healthBadge(h.health)} style={{ padding: '1px 6px' }}>{t(`overview.health.${h.health}`)}</span>
                      {h.title}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {loading && components.length === 0 ? <div className="stub-page">{t('overview.loadingComponents')}</div> : null}

        {layers.map((layer) => (
          <div key={layer}>
            <div className="section-title" style={{ marginTop: 18 }}>{layer}</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('overview.compCol.component')}</th><th>{t('overview.compCol.version')}</th><th>{t('overview.compCol.status')}</th><th>{t('overview.compCol.selfHeal')}</th><th></th></tr></thead>
                <tbody>
                  {components.filter((c) => c.layer === layer).map((c) => {
                    const on = c.status === 'running' || c.status === 'starting';
                    const notDeployed = NOT_DEPLOYED.has(c.status);
                    return (
                      <tr key={c.id}>
                        <td><strong>{c.name}</strong><div className="muted" style={{ fontSize: 11 }}>{c.summary}</div></td>
                        <td className="mono" style={{ fontSize: 12 }} title={c.versionNote}>
                          {c.version ?? '—'}
                          <div className="muted" style={{ fontSize: 11, fontFamily: 'inherit' }}>{c.versionSource === 'component' ? t('overview.versionReported') : c.versionNote}</div>
                        </td>
                        <td><span className={`comp-dot ${statusClass(c.status)}`} style={{ display: 'inline-block', marginRight: 6 }} />{statusLabel(c.status, t)}</td>
                        <td>
                          <span className={`badge ${c.selfHeal.state === 'healthy' ? 'ok' : c.selfHeal.state === 'degraded' ? 'err' : 'muted'}`}>{t(`overview.selfHeal.${c.selfHeal.state}`)}</span>
                          <div className="muted" style={{ fontSize: 11 }}>{c.selfHeal.note}</div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {!c.toggle ? (
                            <span className="pa-tag">{t('overview.core')}</span>
                          ) : notDeployed ? (
                            <span className="pa-tag" title={t('overview.enableInReleaseTitle')}>{t('overview.enableInRelease')}</span>
                          ) : (
                            <button className={`switch${on ? ' on' : ''}`} disabled={busy === c.id} onClick={() => onToggle(c)} style={{ marginLeft: 'auto' }}>
                              <span className="switch-track"><span className="switch-thumb" /></span>
                              <span className="switch-text">{on ? t('overview.on') : t('overview.off')}</span>
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
          {t('overview.auditTitle')}
          <Link href="/governance" className="hint" style={{ marginLeft: 10, textTransform: 'none', letterSpacing: 0 }}>{t('overview.auditLink')}</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t('overview.auditCol.when')}</th><th>{t('overview.auditCol.actor')}</th><th>{t('overview.auditCol.action')}</th><th>{t('overview.auditCol.detail')}</th></tr></thead>
            <tbody>
              {!cockpit || cockpit.recentAudit.length === 0 ? (
                <tr><td colSpan={4} className="muted">{t('overview.auditNone')}</td></tr>
              ) : cockpit.recentAudit.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ fontSize: 11.5 }}>{f.dateTime(e.ts, LEGACY_DT)}</td>
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
        title={pending ? t('overview.disableTitle', { name: pending.name }) : ''}
        // The phrase is what the server checks (`disable <id>`): typed as is, never translated.
        phrase={pending ? `disable ${pending.id}` : ''}
        detail={pending ? t('overview.disableDetail', { name: pending.name }) : ''}
        confirmLabel={t('overview.disable')}
        busy={busy === pending?.id}
        onConfirm={() => pending && toggle(pending, `disable ${pending.id}`)}
        onCancel={() => setPending(null)}
      />

      {/* One panel for the merged tab: the 'overview' variant alone lists the
          UNMANAGED gateway rows, and both variants read the same mirror. */}
      <GatewayPanel variant="overview" />
      {/* The per-system model keys: who has one, the legacy-key sweep, replace a key. */}
      <SystemKeysPanel />
    </>
  );
}
