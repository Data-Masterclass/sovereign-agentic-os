/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { useUser } from '@/lib/useUser';
import { roleAtLeast, type Role } from '@/lib/core/session';

/**
 * The Platform-Admin quick-link tiles, each with a machine-readable minimum role.
 * The grid is filtered FAIL-CLOSED: a tile with no `minRole` a builder clears is
 * hidden (never rendered). Every real platform-admin control is `admin`; the one
 * builder-visible tile is self-service Settings (theme + read-only deployment
 * config at /settings — NOT the tenant-admin /platform/settings page).
 */
type Tile = { label: string; href: string; sub: string; minRole: Role };

const TILES: Tile[] = [
  { label: 'My Settings', href: '/settings', sub: 'Theme · deployment info', minRole: 'builder' },
  { label: 'Domains', href: '/platform/domains', sub: 'Create & toggle optional layers', minRole: 'admin' },
  { label: 'Users & Access', href: '/platform/access', sub: 'Invite via Ory · tenant Admin', minRole: 'admin' },
  { label: 'Models & Providers', href: '/platform/models', sub: 'Defaults · caps · provider keys', minRole: 'admin' },
  { label: 'Drive OAuth apps', href: '/platform/oauth-apps', sub: 'Google & Microsoft apps for connected drives', minRole: 'admin' },
  { label: 'Security & Egress', href: '/platform/security', sub: 'Allowlist · OPA bundle · residency', minRole: 'admin' },
  { label: 'Backups & Restore', href: '/platform/backups', sub: 'Status · guarded restore', minRole: 'admin' },
  { label: 'Plugins', href: '/platform/plugins', sub: 'Curate & install MCPs / skills', minRole: 'admin' },
  { label: 'MCPs & APIs', href: '/platform/mcp-apis', sub: 'Registered MCP servers & API keys', minRole: 'admin' },
  { label: 'Cost & Billing', href: '/platform/billing', sub: 'Envelope · premium cap', minRole: 'admin' },
  { label: 'Settings', href: '/platform/settings', sub: 'SSO · branding · tenant defaults', minRole: 'admin' },
];

type Overview = {
  tenant: { id: string; name: string; residency: string; plan: string };
  opa: string;
  health: { total: number; running: number; source: string };
  counts: { domains: number; domainsActive: number; users: number; usersActive: number; admins: number };
  billing: { envelopeEUR: number; spendEUR: number; pctUsed: number; hardStop: boolean };
  policy: { principals: number; tools: string[]; bundle: string; publish: { status: string; detail: string } };
  alerts: { level: 'warn' | 'info'; text: string; href: string }[];
  recentAudit: { id: string; ts: string; actor: string; action: string; detail: string }[];
};

export default function PlatformOverview() {
  const { user } = useUser();
  const role = user?.role ?? null;
  const isAdmin = role === 'admin';

  // The cockpit aggregate is adminCtx-gated. The builder view early-returns
  // below and never reads this, so its 403 for a builder is inert (never shown).
  const { data, loading, error, reload } = useApi<Overview>('/api/platform-admin/overview');

  // Fail-closed tile filter: hidden means not rendered. A tile shows only if the
  // caller's role clears its minRole; an unknown role (null) sees nothing.
  const tiles = TILES.filter((t) => role !== null && roleAtLeast(role, t.minRole));

  const tileGrid = (
    <>
      <div className="section-title" style={{ marginTop: 22 }}>{isAdmin ? 'Quick links' : 'Available to you'}</div>
      <div className="grid">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="golden">
            <span className="ico">❖</span>
            <span><strong>{t.label}</strong><div className="muted" style={{ fontSize: 11.5 }}>{t.sub}</div></span>
            <span className="arr">→</span>
          </Link>
        ))}
      </div>
    </>
  );

  // Builder view: a tidy self-service surface — no admin KPIs, alerts or audit.
  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Admin" crumb="your platform surface" />
        <div className="content">
          <p className="lead">
            Tenant configuration — identity, users, models, security, billing — is managed by a{' '}
            <strong>platform admin</strong>. Your own domain roles and approvals live in{' '}
            <Link href="/governance">Policies &amp; Approvals</Link>. Below is what you can manage here.
          </p>
          {tileGrid}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Platform Admin" crumb="tenant control room · is the platform healthy & within budget?" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            The tenant cockpit. Platform Admin <strong>configures</strong> structure, identity, models and
            posture; <Link href="/governance">Governance</Link> enforces & sees it, <Link href="/monitoring">Monitoring</Link>{' '}
            watches live spend. Every action here is audited.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? <span className="spin" /> : 'Refresh'}</button>
        </div>

        {error ? <div className="error" style={{ marginTop: 18 }}>{error}</div> : null}

        {data ? (
          <>
            <div className="pa-kpis" style={{ marginTop: 18 }}>
              <div className="card pa-kpi">
                <span className="k-label">Component health</span>
                <span className="k-value">{data.health.running}/{data.health.total}</span>
                <span className="k-sub">{data.health.source === 'live' ? 'running · live cluster' : 'registry · offline'}</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Spend vs envelope</span>
                <span className="k-value">{data.billing.pctUsed}%</span>
                <div className={`pa-bar${data.billing.hardStop ? ' stop' : data.billing.pctUsed >= 80 ? ' warn' : ''}`}>
                  <span style={{ width: `${Math.min(100, data.billing.pctUsed)}%` }} />
                </div>
                <span className="k-sub">€{data.billing.spendEUR} / €{data.billing.envelopeEUR} per mo</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Users</span>
                <span className="k-value">{data.counts.usersActive}</span>
                <span className="k-sub">{data.counts.admins} admin · {data.counts.users} total</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Domains</span>
                <span className="k-value">{data.counts.domainsActive}</span>
                <span className="k-sub">{data.counts.domains} incl. archived</span>
              </div>
              <div className="card pa-kpi">
                <span className="k-label">Compiled to OPA</span>
                <span className="k-value">{data.policy.principals}</span>
                <span className="k-sub">principals · {data.policy.tools.length} tools · {data.policy.publish.status}</span>
              </div>
            </div>

            <div className="section-title">Open admin alerts{data.alerts.length ? <span className="count-pill">{data.alerts.length}</span> : null}</div>
            {data.alerts.length === 0 ? (
              <div className="hint">Nothing needs you. Health green, spend within envelope.</div>
            ) : (
              data.alerts.map((a, i) => (
                <Link key={i} href={a.href} className={`pa-alert ${a.level}`}>
                  <span className="dot" />{a.text}<span className="golden" style={{ border: 'none', background: 'none', marginLeft: 'auto', padding: 0 }}>→</span>
                </Link>
              ))
            )}

            {tileGrid}

            <div className="section-title" style={{ marginTop: 22 }}>
              Recent audit
              <Link href="/governance" className="hint" style={{ marginLeft: 10, textTransform: 'none', letterSpacing: 0 }}>full record in Governance →</Link>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
                <tbody>
                  {data.recentAudit.length === 0 ? (
                    <tr><td colSpan={4} className="muted">No actions yet this session.</td></tr>
                  ) : data.recentAudit.map((e) => (
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
          </>
        ) : loading ? <div className="stub-page" style={{ marginTop: 20 }}>Loading cockpit…</div> : null}
      </div>
    </>
  );
}
