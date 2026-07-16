/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CAPABILITY_MODES, type CapabilityMode, type ConnectionTemplateKey } from '@/lib/connections/schema';
import { type Role } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { SCOPE_GROUPS, groupByScope, groupsFromVisibility, scopeCounts, type ScopeKey } from '@/lib/core/scopes';
import { providerForTemplate, providerConfig, type OAuthProvider } from '@/lib/oauth/providers';
import { driveConnectionStatus, driveAuthorizePath } from '@/lib/oauth/drive-status';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import { useApi } from '@/lib/useApi';
import { WarehouseBrowser } from '@/components/data/WarehouseImportPanel';
import ConnectorWizard, { type WizardStart } from '@/components/connections/ConnectorWizard';
import InstallationGuide from '@/components/connections/InstallationGuide';
import { installGuideFor, type InstallGuide } from '@/lib/connections/install-guides';

/**
 * Governed Connections surface — ONE scroll, no sub-tabs.
 *
 * Layout (top → bottom):
 *   Header — All · My · Shared · Marketplace scope segment, Show archived, ＋ New connector.
 *   1. Connections list — scope-grouped governed connections, with App-MCP connections
 *      (auto-generated from the Software tab) FOLDED IN by scope, tagged "App" and
 *      linking back to their app. Warehouse cards keep Register → Test → Browse → Import.
 *   2. Supported Connectors — a gallery of the connector TYPES you can connect,
 *      rendered dynamically from the connection-template registry the API returns
 *      (data.templates + data.warehouse.providers) so new templates appear on their own.
 *   3. Outbound access / egress allowlist (Builder/Admin only).
 *
 * Both create paths — the header "＋ New connector" (pick any type) and a gallery card's
 * Connect (pre-set to that type) — open the SAME shared <ConnectorWizard>, which drives
 * the SAME governed create route. Credentials go to Secrets Manager (never the record);
 * Builder/Admin then tunes the per-tool capability profile on the card and promotes it up
 * the Personal→Shared→Marketplace ladder. Participants see a read-only consume view.
 */

// ---- Types -----------------------------------------------------------------

type Tool = {
  name: string;
  description: string;
  write: boolean;
  mode: CapabilityMode;
  limits?: { dataScope?: string; rateLimitPerMin?: number; costCapUsd?: number; maxAmount?: number; argConstraints?: string };
};
type Grant = { agent: string; scope: string; tools: string[] };
type Conn = {
  id: string;
  name: string;
  type: string;
  template: string;
  connector: string;
  auth: 'oauth' | 'service';
  health: 'healthy' | 'needs-reconnect' | 'untested';
  dataUsage: 'bronze' | 'files' | null;
  endpoint: string;
  principal: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  /** Soft-archived (retained, reversible). */
  archived?: boolean;
  mode: string;
  secretRef: { name: string; key: string };
  secretSet: boolean;
  secretFingerprint: string;
  egress: { external: boolean; host: string; allowed: boolean };
  tools: Tool[];
  grants: Grant[];
  /** Only on a `warehouse` template: the non-secret federation config (platform + catalog). */
  warehouse?: { platform: string; catalog: string; config?: Record<string, string> };
};
type Template = {
  key: string;
  label: string;
  type: string;
  connector: string;
  auth: 'oauth' | 'service';
  endpointHint: string;
};
type OAuthProviderStatus = { provider: OAuthProvider; label: string; configured: boolean };
/** One external-warehouse provider's create metadata (fields render from this). */
type WarehouseField = { key: string; label: string; required: boolean; help?: string; kind?: string };
type WarehouseProviderMeta = {
  platform: string;
  label: string;
  capabilities: { federate: boolean; import: boolean };
  credentialFields: WarehouseField[];
  secretKeys: string[];
  liveVerificationRequired: string[];
};
type WarehouseMeta =
  | { enabled: false }
  | { enabled: true; template: Template; providers: WarehouseProviderMeta[] };
type Data = {
  user: { id: string; role: Role; domains: string[] };
  connections: Conn[];
  templates: Template[];
  warehouse?: WarehouseMeta;
  canCreate: boolean;
  canCreatePersonal: boolean;
  oauthProviders?: OAuthProviderStatus[];
};
type ApprovalDiff = { field: string; before: unknown; after: unknown };
type ApprovalPreview = {
  action: string;
  args: Record<string, unknown>;
  diff: ApprovalDiff[];
  who: string;
  reason: string;
};
type EgressRequest = { id: string; host: string; reason: string; status: string; requestedBy?: string; at?: string };

type AppTool = { name: string; description: string; write: boolean };
type AppConn = {
  id: string;
  appId: string;
  appSlug: string;
  name: string;
  principal: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  tools: AppTool[];
};
type AppConns = { connections: AppConn[] };

// ---- Helpers ---------------------------------------------------------------

function badge(v: string) { return `badge vis-${v.toLowerCase()}`; }
function modeBadge(m: CapabilityMode) {
  if (m === 'Read') return 'badge ok';
  if (m === 'Write-bounded') return 'badge warn';
  if (m === 'Write-approval') return 'badge warn';
  if (m === 'Blocked') return 'badge err';
  return 'badge muted';
}

/** Shared fetch helper — no side effects, usable anywhere in the file. */
async function postJSON(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

// ---- Main component --------------------------------------------------------

function GovernedConnectionsInner() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>('');
  const [scope, setScope] = useState<ScopeKey>('all');
  const [showArchived, setShowArchived] = useState(false);

  // ?focus=<connectionId> deep-link: once data loads, open (expand) that connection.
  // We do NOT switch scope — the accordion expansion is visible across all scopes, and
  // the scope segment is a filter that may hide the card if the user has changed scope;
  // the simplest honest approach is to leave scope as 'all' (the default) so the target
  // is always visible. A ref prevents re-firing.
  const focusApplied = useRef(false);
  const focusId = searchParams.get('focus') ? decodeURIComponent(searchParams.get('focus')!) : null;
  useEffect(() => {
    if (!focusId || focusApplied.current || !data) return;
    const target = data.connections.find((c) => c.id === focusId);
    if (!target) return; // unknown id — no-op
    focusApplied.current = true;
    setOpen(focusId);
  }, [focusId, data]);

  const load = useCallback(async () => {
    setError('');
    try {
      // ?archived=1 additionally returns soft-archived connections (their own toggle).
      const res = await fetch(`/api/connections${showArchived ? '?archived=1' : ''}`, { cache: 'no-store' });
      const body = await res.json() as Data | { error: string };
      if (!res.ok) setError((body as { error: string }).error ?? 'Failed to load connections');
      else setData(body as Data);
    } catch (e) { setError((e as Error).message); }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  // ---- App MCP connections (auto-generated from Software tab) ----
  const { data: appConns } = useApi<AppConns>('/api/connections/apps');

  // ---- Shared connector wizard (both create paths open the SAME stepper) ----
  // `null` = closed; a WizardStart = open (custom = header button, type = gallery card).
  const [wizard, setWizard] = useState<WizardStart | null>(null);
  const wizardRef = useRef<HTMLDivElement>(null);
  const openWizard = useCallback((start: WizardStart) => {
    setWizard(start);
    // Bring the (now-visible) wizard into view — it renders just under the header.
    requestAnimationFrame(() => wizardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);

  // The Supported Connector whose Installation Guide side-panel is open (null = none).
  const [guide, setGuide] = useState<InstallGuide | null>(null);

  // Supported Connectors: search query + which category groups are collapsed.
  const [connSearch, setConnSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const warehouseMeta = data?.warehouse?.enabled ? data.warehouse : null;
  const canCreate = data?.canCreate ?? false;
  const canCreatePersonal = data?.canCreatePersonal ?? false;

  if (!data && !error) return <div className="hint"><span className="spin" /> Loading connections…</div>;

  return (
    <ConfirmProvider>

      {/* ── Header (canonical artifact-tab header) ── */}
      {/* Lead left; Show archived + ＋ New connector right; scope segment below. The
          Show-archived toggle is intentionally always-solid — do NOT restyle it. */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <p className="lead" style={{ margin: 0, maxWidth: 560 }}>
          Governed connections — each connects with your own account, stores only a token
          <em> reference</em> (never the value), and rides the same visibility ladder as every
          other artifact.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn ghost"
            style={{ opacity: 1 }}
            onClick={() => setShowArchived((v) => !v)}
            title="Archived connections are hidden by default"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          {(canCreate || canCreatePersonal) ? (
            <button className="btn" onClick={() => openWizard({ mode: 'custom' })}>＋ New connector</button>
          ) : null}
        </div>
      </div>
      {error ? <div className="error" style={{ marginTop: 14 }}>{error}</div> : null}

      {/* The shared wizard — opens under the header for BOTH create paths (header
          "＋ New connector" = custom; a Supported card's Connect = pre-set to that type). */}
      <div ref={wizardRef} style={{ scrollMarginTop: 16 }}>
        {wizard && data ? (
          <ConnectorWizard
            data={{ templates: data.templates, warehouse: data.warehouse, canCreate, canCreatePersonal }}
            start={wizard}
            onDone={load}
            onCancel={() => setWizard(null)}
          />
        ) : null}
      </div>

      {/* ── 1. Connections list (scope-grouped; App-MCP folded in by scope) ── */}
      {(() => {
        if (!data) return null;
        // Governed connections + App-MCP connections share the SAME four scope groups
        // (My / Shared / Marketplace by visibility+owner). App connections fold into the
        // caller's scope: my app → My, a Shared app → Shared, etc.
        const groups = groupsFromVisibility(data.connections);
        const scopedConns = groupByScope(groups, data.user.id)[scope];
        const apps = appConns?.connections ?? [];
        const scopedApps = groupByScope(groupsFromVisibility(apps), data.user.id)[scope];
        // Counts include both governed + app connections so the segment reflects the list.
        const cCounts = scopeCounts(groups, data.user.id);
        const aCounts = scopeCounts(groupsFromVisibility(apps), data.user.id);
        const counts = { all: cCounts.all + aCounts.all, mine: cCounts.mine + aCounts.mine, shared: cCounts.shared + aCounts.shared, marketplace: cCounts.marketplace + aCounts.marketplace };
        const empty = scopedConns.length === 0 && scopedApps.length === 0;
        return (
          <>
            {/* Scope switcher — the OS-wide four groups: All · My · Shared · Marketplace. */}
            <div className="seg" style={{ marginBottom: 14 }}>
              {SCOPE_GROUPS.map((g) => (
                <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
                  {g.label('Connections')} ({counts[g.key]})
                </button>
              ))}
            </div>
            {empty ? (
              <div className="stub-page">
                {scope === 'mine' || scope === 'all'
                  ? <>No connections yet{(canCreate || canCreatePersonal) ? ' — use ＋ New connector, or pick a Supported connector below.' : '.'}</>
                  : scope === 'shared' ? 'Nothing in Domain yet.' : 'Nothing in Company yet.'}
              </div>
            ) : (
              <>
                {scopedConns.map((c) => (
                  <ConnectionCard
                    key={c.id}
                    c={c}
                    role={data.user.role}
                    me={data.user}
                    oauthProviders={data.oauthProviders ?? []}
                    open={open === c.id}
                    onToggle={() => setOpen(open === c.id ? '' : c.id)}
                    onChange={load}
                  />
                ))}
                {scopedApps.map((c) => <AppConnectionCard key={c.id} c={c} />)}
              </>
            )}
          </>
        );
      })()}

      {/* ── 2. Supported Connectors (grouped by category + search) ── */}
      <div className="section-title" style={{ marginTop: 28 }}>Supported connectors</div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        The connector types you can connect, straight from the template registry — inbound
        sources (warehouse, Google Drive, OneDrive, Notion) and any new template the platform
        adds appear here automatically. <strong>Connect</strong> opens the wizard pre-set to that
        type. For an arbitrary outbound API or MCP, use <strong>＋ New connector</strong> above.
      </p>
      {(() => {
        if (!data) return null;
        // A gallery card. `guideKey` resolves its Installation Guide (a warehouse card
        // uses its provider platform; a template card uses its template key). `start`
        // is how Connect opens the shared wizard (a warehouse card pins the platform).
        type Card = { key: string; guideKey: string; label: string; meta: string; blurb?: string; category: string; start: WizardStart };

        // Category taxonomy — maps template keys and warehouse platforms to display categories.
        // Warehouse platforms → Data warehouses; operational databases → Operational databases.
        // New connectors (e.g. postgres/mysql/sqlserver/mongodb from the DB agent) are derived
        // by provider name below so they group correctly without touching warehouse-provider files.
        const TEMPLATE_CATEGORY: Record<string, string> = {
          'gdrive':        'Docs & Knowledge',
          'onedrive':      'Docs & Knowledge',
          'notion-mcp':    'Docs & Knowledge',
          'airflow':       'Orchestration',
          'om-catalog':    'Catalog',
          'salesforce-api':'Enterprise apps',
          'generic-mcp':   'LLM providers',
          'generic-api':   'Enterprise apps',
          'database':      'Operational databases',
          'warehouse':     'Data warehouses',
        };
        const WAREHOUSE_PLATFORM_CATEGORY: Record<string, string> = {
          'glue':             'Data warehouses',
          'snowflake':        'Data warehouses',
          'bigquery':         'Data warehouses',
          'databricks-delta': 'Data warehouses',
          'fabric':           'Data warehouses',
        };

        // Dynamic: one card per user-facing template the API returned…
        const cards: Card[] = data.templates.map((t) => ({
          key: t.key,
          guideKey: t.key,
          label: t.label,
          meta: `${t.type} · ${t.auth === 'oauth' ? 'personal OAuth' : 'service credentials'}`,
          category: TEMPLATE_CATEGORY[t.key] ?? t.type,
          start: { mode: 'type', template: t.key },
        }));

        // …plus ONE card PER warehouse provider (not a single generic warehouse card)
        // when the operator enabled external connectors. Each Connect opens the wizard
        // pre-set to that platform so it skips the generic platform-choice step.
        if (warehouseMeta) {
          for (const p of warehouseMeta.providers) {
            const caps = [p.capabilities.federate ? 'federate' : null, p.capabilities.import ? 'import' : null]
              .filter(Boolean).join(' · ');
            // Derive category: known platforms → Data warehouses; anything db-like → Operational databases.
            const cat = WAREHOUSE_PLATFORM_CATEGORY[p.platform]
              ?? (/postgres|mysql|sqlserver|mongodb|mongo/i.test(p.platform) ? 'Operational databases' : 'Data warehouses');
            cards.push({
              key: `warehouse:${p.platform}`,
              guideKey: p.platform,
              label: p.label,
              meta: `Warehouse · federated Trino catalog${caps ? ` · ${caps}` : ''}`,
              blurb: 'Federate this lakehouse as one governed catalog — query live under OPA, then import tables as owned products.',
              category: cat,
              start: { mode: 'type', template: 'warehouse', presetPlatform: p.platform },
            });
          }
        }

        if (cards.length === 0) return <div className="stub-page">No connector types available on this deployment.</div>;
        const canOpen = canCreate || canCreatePersonal;

        // Filter by search query (name or category, case-insensitive).
        const q = connSearch.trim().toLowerCase();
        const filtered = q
          ? cards.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q))
          : cards;

        // Group filtered cards by category, preserving a consistent category order.
        const CATEGORY_ORDER = [
          'Docs & Knowledge',
          'Messaging',
          'Calendar',
          'Code & DevOps',
          'Operational databases',
          'Data warehouses',
          'Data ingest',
          'Enterprise apps',
          'Orchestration',
          'Catalog',
          'Observability',
          'LLM providers',
        ];
        const grouped = new Map<string, Card[]>();
        for (const c of filtered) {
          const list = grouped.get(c.category) ?? [];
          list.push(c);
          grouped.set(c.category, list);
        }
        // Sort categories: known order first, unknowns appended alphabetically.
        const sortedCategories = [...grouped.keys()].sort((a, b) => {
          const ia = CATEGORY_ORDER.indexOf(a);
          const ib = CATEGORY_ORDER.indexOf(b);
          if (ia !== -1 && ib !== -1) return ia - ib;
          if (ia !== -1) return -1;
          if (ib !== -1) return 1;
          return a.localeCompare(b);
        });

        return (
          <>
            {/* Search bar */}
            <div style={{ marginBottom: 18 }}>
              <input
                type="search"
                value={connSearch}
                onChange={(e) => setConnSearch(e.target.value)}
                placeholder="Search connectors by name or category…"
                style={{ width: '100%', maxWidth: 400 }}
              />
            </div>

            {filtered.length === 0 ? (
              <div className="stub-page">No connectors match &ldquo;{connSearch}&rdquo;.</div>
            ) : (
              sortedCategories.map((cat) => {
                const group = grouped.get(cat)!;
                const isOpen = !collapsedCategories.has(cat);
                return (
                  <div key={cat} style={{ marginBottom: 20 }}>
                    {/* Group header */}
                    <button
                      type="button"
                      onClick={() => setCollapsedCategories((prev) => {
                        const next = new Set(prev);
                        if (next.has(cat)) next.delete(cat); else next.add(cat);
                        return next;
                      })}
                      style={{
                        all: 'unset',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: isOpen ? 10 : 0,
                        width: '100%',
                      }}
                    >
                      <span style={{
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        color: 'var(--text-faint)',
                        userSelect: 'none',
                      }}>
                        {isOpen ? '▾' : '▸'} {cat}
                      </span>
                      <span className="badge muted" style={{ fontSize: 10 }}>{group.length}</span>
                      <span style={{ flex: 1, height: 1, background: 'var(--border)', marginLeft: 4 }} />
                    </button>

                    {/* Cards grid — hidden when collapsed */}
                    {isOpen ? (
                      <div className="grid">
                        {group.map((c) => {
                          const g = installGuideFor(c.guideKey);
                          return (
                            <div className="card" key={c.key}>
                              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                                <h3 style={{ margin: 0 }}>{c.label}</h3>
                                <span className="badge ok">available</span>
                              </div>
                              <div className="muted" style={{ marginTop: 8 }}>{c.meta}</div>
                              {c.blurb ? <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>{c.blurb}</p> : null}
                              <div className="row" style={{ marginTop: 12, gap: 8, justifyContent: 'flex-end' }}>
                                {g ? (
                                  <button className="btn ghost" onClick={() => setGuide(g)}>Installation Guide</button>
                                ) : null}
                                {canOpen ? (
                                  <button className="btn ghost" onClick={() => openWizard(c.start)}>Connect →</button>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </>
        );
      })()}

      {/* ── 3. Outbound access (Builder/Admin only) ── */}
      {canCreate ? <EgressSection /> : null}

      {/* Installation Guide side panel — opened from any Supported Connector card. */}
      {guide ? <InstallationGuide guide={guide} onClose={() => setGuide(null)} /> : null}

    </ConfirmProvider>
  );
}

// ---- Egress section --------------------------------------------------------

function EgressSection() {
  const [requests, setRequests] = useState<EgressRequest[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [host, setHost] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const loadEgress = useCallback(async () => {
    try {
      const res = await fetch('/api/egress', { cache: 'no-store' });
      const body = await res.json() as { requests?: EgressRequest[]; error?: string };
      if (res.ok) setRequests(body.requests ?? []);
      else setLoadErr(body.error ?? 'Failed to load egress requests');
    } catch (e) { setLoadErr((e as Error).message); }
  }, []);

  useEffect(() => { loadEgress(); }, [loadEgress]);

  async function requestEgress() {
    if (!host.trim() || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await postJSON('/api/egress', { host: host.trim(), reason: reason.trim() });
      if (r.ok) {
        setMsg(`✓ Egress request submitted for "${host.trim()}" — pending Admin approval in the Governance tab.`);
        setHost('');
        setReason('');
        loadEgress();
      } else {
        setMsg(`✗ ${(r.data.error as string) ?? 'Could not submit request'}`);
      }
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 28 }}>Outbound access</div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
        External endpoints must be on the egress allowlist before a connection can reach them.
        Request access below — an Administrator approves in the Governance tab.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="Host (e.g. api.salesforce.com)"
          style={{ flex: '2 1 160px' }}
        />
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for access"
          style={{ flex: '3 1 200px' }}
        />
        <button className="btn ghost" onClick={requestEgress} disabled={busy || !host.trim()}>
          {busy ? <span className="spin" /> : 'Request egress'}
        </button>
      </div>
      {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 8 }}>{msg}</div> : null}
      {loadErr ? <div className="error" style={{ marginTop: 8 }}>{loadErr}</div> : null}
      {requests.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr><th>Host</th><th>Reason</th><th>Status</th></tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.host}</td>
                  <td className="muted">{r.reason}</td>
                  <td>
                    <span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'err' : 'muted'}`}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

// ---- Connection card -------------------------------------------------------

const AUTONOMOUS_PRESETS = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'] as const;
type AutonomousPreset = typeof AUTONOMOUS_PRESETS[number];

/** Connection visibility → the OS-wide lifecycle visibility (drives the delete gate). */
const connVisibility = (v: Conn['visibility']): Visibility =>
  v === 'Shared' ? 'shared' : v === 'Certified' ? 'certified' : 'personal';

/** Display word for a connection's stored visibility. Mirrors lib/core/scopes.ts
 *  (source of truth): Personal→"My", Shared→"Domain", Certified→"Company". */
const visWord = (v: Conn['visibility']): string =>
  v === 'Shared' ? 'Domain' : v === 'Certified' ? 'Company' : 'My';

/** Register outcome (backend route wraps registerWarehouseCatalog → RegisterK8sOutcome). */
type RegisterResult = { ok?: boolean; catalog?: string; detail?: string; error?: string };
/** Test outcome (existing route: SHOW SCHEMAS through the governed query path). */
type TestResult = { ok?: boolean; detail?: string; error?: string };

/**
 * Warehouse lifecycle — the clean inline steps a builder expects on a warehouse
 * connection: Register the Trino catalog (one click), Test it (SHOW SCHEMAS), then
 * Browse its schemas/tables. No YAML, no raw catalog properties — Connect → Register
 * → Test → Browse. A rolling Trino restart is slow, so after Register we poll Test.
 */
function WarehouseControls({ c, canManage, onChange }: { c: Conn; canManage: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState('');
  const [regMsg, setRegMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [registered, setRegistered] = useState(c.health === 'healthy');
  const [browsing, setBrowsing] = useState(false);

  async function register() {
    setBusy('register');
    setRegMsg('Registering catalog… a rolling Trino restart can take 60–90s.');
    setTestMsg('');
    try {
      const r = await postJSON(`/api/connections/${c.id}/register`);
      const d = r.data as RegisterResult;
      if (r.ok && d.ok !== false) {
        setRegMsg(`✓ Registered catalog '${d.catalog ?? c.warehouse?.catalog ?? ''}'. ${d.detail ?? 'Testing…'}`);
        setRegistered(true);
        onChange();
        // Trino re-reads its catalog mount on the rolling restart — poll Test until it answers.
        await pollTest();
      } else {
        setRegMsg(`✗ ${d.error ?? d.detail ?? 'Could not register the catalog'}`);
      }
    } catch (e) {
      setRegMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function pollTest() {
    // Up to ~90s: the pod restart is the slow part. Stop as soon as SHOW SCHEMAS answers ok.
    for (let i = 0; i < 9; i++) {
      await new Promise((res) => setTimeout(res, 10_000));
      try {
        const r = await postJSON(`/api/connections/${c.id}/test`);
        const d = r.data as TestResult;
        if (d.ok) { setTestMsg(`✓ ${d.detail ?? 'Catalog is queryable.'}`); onChange(); return; }
      } catch { /* keep polling */ }
    }
    setTestMsg('Still waiting on Trino — click Test again in a moment.');
  }

  async function test() {
    setBusy('test');
    setTestMsg('');
    try {
      const r = await postJSON(`/api/connections/${c.id}/test`);
      const d = r.data as TestResult;
      // The route returns 200 even on a not-yet-registered catalog; branch on payload ok.
      setTestMsg(d.ok ? `✓ ${d.detail}` : `✗ ${d.error ?? d.detail ?? 'Register the catalog first, then test.'}`);
      if (d.ok) { setRegistered(true); onChange(); }
    } catch (e) {
      setTestMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {registered
          ? <span className="badge ok">catalog registered</span>
          : <span className="badge muted">needs register</span>}
        {canManage ? (
          <button className="btn ghost" onClick={register} disabled={busy !== ''}>
            {busy === 'register' ? <span className="spin" /> : registered ? 'Re-register' : 'Register catalog'}
          </button>
        ) : null}
        <button className="btn ghost" onClick={test} disabled={busy !== ''}>
          {busy === 'test' ? <span className="spin" /> : 'Test'}
        </button>
        <button className="btn ghost" onClick={() => setBrowsing((v) => !v)} disabled={busy !== ''}>
          {browsing ? 'Hide browse' : 'Browse'}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 11.5 }}>
        <strong>Register</strong> mounts this source as one governed Trino catalog (one click — no YAML).
        <strong> Test</strong> runs <span className="mono">SHOW SCHEMAS</span> through the governed query path.
        <strong> Browse</strong> lists schemas &amp; tables. Import a table into your lakehouse from the
        Data tab’s <em>Import from warehouse</em>.
      </p>
      {regMsg ? <div className={regMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{regMsg}</div> : null}
      {testMsg ? <div className={testMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{testMsg}</div> : null}
      {browsing ? <WarehouseBrowser connId={c.id} onSelect={() => { /* browse-only preview here; import lives in the Data tab */ }} /> : null}
    </div>
  );
}

/**
 * App-MCP connection card — an auto-generated connection from the Software tab, folded
 * into the scope list alongside governed connections. Tagged "App" and links to its app.
 * Read-only here: the app owns its lifecycle (capabilities live on the app in Software).
 */
function AppConnectionCard({ c }: { c: AppConn }) {
  const toolNames = c.tools.map((t) => t.name).join(', ');
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>
            {c.name}
            <span className="badge" style={{ marginLeft: 6 }}>App</span>
          </h3>
          <div className="muted mono" style={{ marginTop: 6, fontSize: 11.5 }}>
            {c.principal} · {c.owner}/{c.domain}
          </div>
          <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }} title={toolNames}>
            Tools: {toolNames || '(none)'}
          </div>
        </div>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 12 }}>
          {(c.visibility === 'Shared' || c.visibility === 'Certified') ? <DomainTag domain={c.domain} /> : null}
          <span className={badge(c.visibility)}>{visWord(c.visibility)}</span>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 10, marginBottom: 0, fontSize: 11.5 }}>
        Auto-generated when you built this app in the Software tab — building an app and creating a
        connection are one act. Manage it from its app.
      </p>
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <Link className="btn ghost" href={`/software/${c.appId}`}>Open app →</Link>
      </div>
    </div>
  );
}

function ConnectionCard({
  c, role, me, oauthProviders, open, onToggle, onChange,
}: {
  c: Conn; role: Role; me: { id: string; role: Role; domains: string[] }; oauthProviders: OAuthProviderStatus[]; open: boolean; onToggle: () => void; onChange: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [confirmDemote, setConfirmDemote] = useState(false);
  const [draft, setDraft] = useState<Tool[]>(c.tools);
  const [approvalState, setApprovalState] = useState<{
    tool: string; args: Record<string, unknown>; preview: ApprovalPreview;
  } | null>(null);
  const [dataUsage, setDataUsage] = useState<'bronze' | 'files' | null>(c.dataUsage);
  // Attach to a specific agent (grant, restrict-only)
  const [grantAgent, setGrantAgent] = useState('sales-assistant');
  const [grantScope, setGrantScope] = useState<'read-only' | 'full'>('read-only');
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMsg, setGrantMsg] = useState('');
  // Autonomous preset
  const [agentPrincipal, setAgentPrincipal] = useState('sales-assistant');
  const [autonomousPreset, setAutonomousPreset] = useState<AutonomousPreset>('read-only');
  const [presetBusy, setPresetBusy] = useState(false);
  const [autonomousMsg, setAutonomousMsg] = useState('');

  // Fail-closed edit-scope (defense-in-depth; server is the authority): only the
  // owner, a domain_admin of the owning domain, or an admin sees manage controls.
  const canManage = canManageArtifact(me, { owner: c.owner, domain: c.domain });
  const exposed = c.tools.filter((t) => t.mode === 'Read' || t.mode === 'Write-approval' || t.mode === 'Write-bounded');
  const isDrive = c.connector === 'drive' || c.type === 'Drive';
  // Warehouse connection: its lifecycle is Register → Test → Browse (its own control
  // block below), not the generic reachability Test the other connectors use.
  const isWarehouse = c.template === 'warehouse';

  // Notion hosted-MCP connection: a per-user OAuth (DCR + PKCE) connect flow that
  // proves liveness with a real MCP tools/list. Status derives from the same safe
  // health field a Drive uses (untested → Not connected; healthy → Connected).
  const isNotion = c.template === 'notion-mcp';
  const notionStatus = driveConnectionStatus(c);
  const [notionTools, setNotionTools] = useState<{ name: string; description?: string }[] | null>(null);
  const [notionMsg, setNotionMsg] = useState('');

  function connectNotion() {
    window.location.href = `/api/connections/notion/authorize?connectionId=${encodeURIComponent(c.id)}`;
  }

  async function verifyNotion() {
    setBusy('verify-notion');
    setNotionMsg('');
    try {
      const r = await postJSON(`/api/connections/${c.id}/mcp-tools`);
      const detail = (r.data.detail as string) ?? (r.data.error as string) ?? 'Verification failed';
      setNotionMsg(`${r.data.ok ? '✓' : '✗'} ${detail}`);
      setNotionTools((r.data.tools as { name: string; description?: string }[]) ?? []);
      if (r.data.ok) onChange();
    } catch (e) {
      setNotionMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  }

  async function disconnectNotion() {
    if (typeof window !== 'undefined' && !window.confirm(`Disconnect "${c.name}"? This removes the connection and its stored token.`)) return;
    setBusy('disconnect');
    setNotionMsg('');
    try {
      const res = await fetch(`/api/connections/${c.id}`, { method: 'DELETE' });
      if (res.ok) { onChange(); return; }
      const d = await res.json() as { error?: string };
      setNotionMsg(`✗ ${d.error ?? 'Could not disconnect'}`);
    } catch (e) {
      setNotionMsg(`✗ ${(e as Error).message}`);
    } finally { setBusy(''); }
  }

  // Personal-drive OAuth wiring: which provider this drive federates to, whether an
  // admin has registered its OAuth app, and the current connect status. A user
  // connects their OWN drive via the provider consent screen (full-page navigation).
  const driveProvider: OAuthProvider | null = isDrive && c.auth === 'oauth'
    ? providerForTemplate(c.template as ConnectionTemplateKey)
    : null;
  const driveProviderStatus = driveProvider ? oauthProviders.find((p) => p.provider === driveProvider) : undefined;
  const driveProviderConfigured = driveProviderStatus?.configured ?? false;
  const driveProviderLabel = driveProvider ? providerConfig(driveProvider).label : '';
  const driveStatus = driveConnectionStatus(c);

  /** The "Connect"/"Reconnect" button navigates full-page — the route 302s to consent. */
  function connectDrive() {
    if (!driveProvider) return;
    window.location.href = driveAuthorizePath(driveProvider, c.id);
  }

  async function disconnectDrive() {
    if (typeof window !== 'undefined' && !window.confirm(`Disconnect "${c.name}"? This removes the connection and its stored token. You can reconnect by adding it again.`)) return;
    setBusy('disconnect');
    setMsg('');
    try {
      const res = await fetch(`/api/connections/${c.id}`, { method: 'DELETE' });
      if (res.ok) { onChange(); return; }
      const d = await res.json() as { error?: string };
      setMsg(`✗ ${d.error ?? 'Could not disconnect'}`);
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally { setBusy(''); }
  }

  /** Card-level POST — tracks the global busy state so all buttons disable. */
  async function doPost(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    setBusy(path);
    setMsg('');
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await res.json() as Record<string, unknown>;
      return { ok: res.ok, status: res.status, data };
    } finally { setBusy(''); }
  }

  async function test() {
    const r = await doPost(`/api/connections/${c.id}/test`);
    // Branch on the PAYLOAD's ok, not the HTTP status — the route always
    // returns 200 even on credential/connectivity failure, with ok:false.
    setMsg((r.data.ok as boolean)
      ? `✓ ${r.data.detail as string}`
      : `✗ ${(r.data.error as string) ?? (r.data.detail as string)}`);
  }

  async function promote() {
    const r = await doPost(`/api/connections/${c.id}/promote`);
    const conn = r.data.connection as Conn | undefined;
    setMsg(r.ok ? `✓ Promoted to ${conn ? visWord(conn.visibility) : ''}` : `✗ ${r.data.error as string}`);
    if (r.ok) onChange();
  }

  async function demote() {
    const r = await doPost(`/api/connections/${c.id}/demote`);
    const conn = r.data.connection as Conn | undefined;
    setMsg(r.ok ? `✓ Revoked → ${conn ? visWord(conn.visibility) : ''}` : `✗ ${r.data.error as string}`);
    if (r.ok) onChange();
  }

  async function saveCaps() {
    const updates = draft.map((t) => ({ name: t.name, mode: t.mode, limits: t.limits }));
    const r = await doPost(`/api/connections/${c.id}/capabilities`, { updates });
    setMsg(r.ok ? '✓ Capability profile saved + recompiled into OPA policy' : `✗ ${r.data.error as string}`);
    if (r.ok) onChange();
  }

  async function setUsage() {
    const usage = isDrive ? 'files' : 'bronze';
    const r = await doPost(`/api/connections/${c.id}/usage`, { usage });
    if (r.ok) {
      const updated = r.data.connection as Conn | undefined;
      setDataUsage(updated?.dataUsage ?? usage);
    } else {
      setMsg(`✗ ${r.data.error as string}`);
    }
  }

  async function tryTool(toolName: string, opts?: { asAgent?: string; autonomous?: boolean }) {
    const t = draft.find((x) => x.name === toolName);
    const args: Record<string, unknown> = t?.mode === 'Write-bounded'
      ? { id: 'OPP-1', amount: t.limits?.maxAmount ?? 1000 }
      : { id: 'acct-1' };
    const body: Record<string, unknown> = { tool: toolName, args };
    if (opts?.asAgent) { body.asAgent = opts.asAgent; body.autonomous = opts.autonomous ?? false; }
    const r = await doPost(`/api/connections/${c.id}/tool`, body);
    const d = r.data;
    if (d.decision === 'requires_approval' && d.preview) {
      setApprovalState({ tool: toolName, args, preview: d.preview as ApprovalPreview });
    } else {
      setApprovalState(null);
      const icon = d.decision === 'allow' ? '✓' : d.decision === 'block' ? '✗' : '⏸';
      const tail = d.queuedForReview ? ' — blocked, queued to Governance inbox' : '';
      setMsg(`${icon} ${toolName}: ${d.decision as string} — ${(d.reason ?? d.error) as string}${tail}`);
      if (d.decision === 'requires_approval') onChange();
    }
  }

  async function approveOnce() {
    if (!approvalState) return;
    const { tool, args } = approvalState;
    const r = await doPost(`/api/connections/${c.id}/approve`, { tool, args });
    const d = r.data;
    setApprovalState(null);
    setMsg(r.ok
      ? `✓ ${tool}: approved inline and executed once — ${(d.reason ?? '') as string}`
      : `✗ ${(d.error ?? d.reason) as string}`);
    if (r.ok) onChange();
  }

  function denyApproval() {
    if (!approvalState) return;
    const { tool } = approvalState;
    setApprovalState(null);
    setMsg(`✗ ${tool}: denied — not executed`);
  }

  async function approveRemember() {
    if (!approvalState) return;
    const { tool, args } = approvalState;
    const r = await doPost(`/api/connections/${c.id}/remember`, { tool, args });
    setApprovalState(null);
    setMsg(r.ok
      ? '✓ Standing policy created — identical calls now auto-run'
      : `✗ ${r.data.error as string}`);
  }

  async function attachAgent() {
    if (!grantAgent.trim() || grantBusy) return;
    setGrantBusy(true);
    setGrantMsg('');
    const r = await postJSON(`/api/connections/${c.id}/grant`, {
      agent: grantAgent.trim(),
      scope: grantScope,
    });
    setGrantMsg(r.ok
      ? `✓ Attached to ${grantAgent.trim()} (${grantScope}) — other agents don't see this connection`
      : `✗ ${r.data.error as string}`);
    setGrantBusy(false);
    if (r.ok) onChange();
  }

  async function setPreset() {
    if (!agentPrincipal.trim() || presetBusy) return;
    setPresetBusy(true);
    setAutonomousMsg('');
    const r = await postJSON(`/api/connections/${c.id}/autonomous`, {
      agent: agentPrincipal.trim(),
      preset: autonomousPreset,
    });
    setAutonomousMsg(r.ok
      ? `✓ Preset "${autonomousPreset}" applied to ${agentPrincipal.trim()}`
      : `✗ ${r.data.error as string}`);
    setPresetBusy(false);
  }

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      {/* Header */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>
            {c.name}
            <span className="badge muted" style={{ marginLeft: 6 }}>{c.type}</span>
            {c.health === 'healthy' && <span className="badge ok" style={{ marginLeft: 4 }}>healthy</span>}
            {c.health === 'needs-reconnect' && <span className="badge err" style={{ marginLeft: 4 }}>needs reconnect</span>}
            {c.health === 'untested' && <span className="badge muted" style={{ marginLeft: 4 }}>untested</span>}
          </h3>
          <div className="muted mono" style={{ marginTop: 6, fontSize: 11.5 }}>
            {c.connector} · {c.auth === 'oauth' ? 'personal OAuth' : 'service creds'} · {c.principal} · {c.owner}/{c.domain} · {c.endpoint}
          </div>
        </div>
        <div className="row" style={{ gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 12 }}>
          {c.archived ? <span className="badge muted">archived</span> : null}
          {dataUsage === 'bronze' && <span className="badge warn">Bronze source</span>}
          {dataUsage === 'files' && <span className="badge warn">Files index</span>}
          {(c.visibility === 'Shared' || c.visibility === 'Certified') ? <DomainTag domain={c.domain} /> : null}
          <span className={badge(c.visibility)}>{visWord(c.visibility)}</span>
        </div>
      </div>

      {/* Secret + egress */}
      <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
        Secret: <span className="mono">{c.secretRef.name}/{c.secretRef.key}</span>{' '}
        {c.secretSet
          ? <span className="badge ok">stored</span>
          : <span className="badge muted">none</span>}{' '}
        {c.secretFingerprint
          ? <span className="mono" style={{ fontSize: 11 }}>{c.secretFingerprint}</span>
          : null}
        <span style={{ marginLeft: 10 }}>
          Egress:{' '}
          {c.egress.external
            ? <span className={`badge ${c.egress.allowed ? 'ok' : 'err'}`}>{c.egress.host} {c.egress.allowed ? 'allowed' : 'blocked'}</span>
            : <span className="badge muted">internal</span>}
        </span>
      </div>

      {/* Exposed tools + grants */}
      <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
        Exposed tools: <span className="mono">{exposed.map((t) => t.name).join(', ') || '(none)'}</span>
        {c.grants.length
          ? <span style={{ marginLeft: 10 }}>Grants: {c.grants.map((g) => `${g.agent} (${g.scope})`).join(', ')}</span>
          : null}
      </div>

      {/* Marketplace note */}
      {c.visibility === 'Certified' ? (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          Marketplace template — consumers bring their own credentials.
        </div>
      ) : null}

      {/* Personal-drive connect status + controls (own account, own consent). */}
      {driveProvider ? (
        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {driveStatus === 'connected'
            ? <span className="badge ok">Connected as {c.owner}</span>
            : driveStatus === 'needs-reconnect'
              ? <span className="badge err">Needs reconnect</span>
              : <span className="badge muted">Not connected</span>}
          {!driveProviderConfigured ? (
            <span className="hint" style={{ fontSize: 12 }}>
              An administrator must configure the {driveProviderLabel} OAuth app first.
            </span>
          ) : driveStatus === 'connected' ? (
            <>
              <button className="btn ghost" onClick={connectDrive} disabled={busy !== ''}>Reconnect</button>
              <button className="btn ghost" onClick={disconnectDrive} disabled={busy !== ''}>Disconnect</button>
            </>
          ) : driveStatus === 'needs-reconnect' ? (
            <>
              <button className="btn" onClick={connectDrive} disabled={busy !== ''}>Reconnect</button>
              <button className="btn ghost" onClick={disconnectDrive} disabled={busy !== ''}>Disconnect</button>
            </>
          ) : (
            <button className="btn" onClick={connectDrive} disabled={busy !== ''}>Connect {driveProviderLabel}</button>
          )}
        </div>
      ) : null}

      {/* Notion hosted-MCP connect status + controls (own workspace, own consent). */}
      {isNotion ? (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {notionStatus === 'connected'
              ? <span className="badge ok">Connected as {c.owner}</span>
              : notionStatus === 'needs-reconnect'
                ? <span className="badge err">Needs reconnect</span>
                : <span className="badge muted">Not connected</span>}
            {notionStatus === 'connected' ? (
              <>
                <button className="btn ghost" onClick={verifyNotion} disabled={busy !== ''}>
                  {busy === 'verify-notion' ? <span className="spin" /> : 'Verify · list tools'}
                </button>
                <button className="btn ghost" onClick={connectNotion} disabled={busy !== ''}>Reconnect</button>
                <button className="btn ghost" onClick={disconnectNotion} disabled={busy !== ''}>Disconnect</button>
              </>
            ) : notionStatus === 'needs-reconnect' ? (
              <>
                <button className="btn" onClick={connectNotion} disabled={busy !== ''}>Reconnect</button>
                <button className="btn ghost" onClick={disconnectNotion} disabled={busy !== ''}>Disconnect</button>
              </>
            ) : (
              <button className="btn" onClick={connectNotion} disabled={busy !== ''}>Connect Notion</button>
            )}
          </div>
          <p className="hint" style={{ marginTop: 6, marginBottom: 0, fontSize: 11.5 }}>
            Connect signs you in to Notion and authorizes your own workspace via Notion&apos;s hosted MCP
            (OAuth 2.1 · PKCE). Only a token <em>reference</em> is stored — never the token itself.
            {' '}<strong>Verify · list tools</strong> runs a real MCP tools/list to prove the connection is live.
          </p>
          {notionMsg ? (
            <div className={notionMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{notionMsg}</div>
          ) : null}
          {notionTools && notionTools.length > 0 ? (
            <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>
              Live tools: {notionTools.map((t) => t.name).join(', ')}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Warehouse lifecycle — Register → Test → Browse (its own block; no YAML). */}
      {isWarehouse ? <WarehouseControls c={c} canManage={canManage} onChange={onChange} /> : null}

      {/* Action buttons */}
      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
        {driveProvider || isNotion || isWarehouse ? null : c.health === 'needs-reconnect'
          ? <button className="btn ghost" onClick={test} disabled={busy !== ''}>Reconnect</button>
          : <button className="btn ghost" onClick={test} disabled={busy !== ''}>Test</button>}
        <button className="btn ghost" onClick={onToggle}>
          {open ? 'Hide capabilities' : 'Capabilities'}
        </button>
        {canManage && c.visibility !== 'Certified' ? (
          <button className="btn ghost" onClick={promote} disabled={busy !== ''}>
            {c.visibility === 'Personal' ? 'Promote to Domain' : 'Certify to Company'}
          </button>
        ) : null}
        {/* Revoke sharing (demote). Certified→Shared is admin-only; Shared→Personal is
            builder+ (owner enforced server-side). The server is the fail-closed authority. */}
        {((c.visibility === 'Certified' && role === 'admin') || (c.visibility === 'Shared' && canManage)) ? (
          confirmDemote ? (
            <>
              <button className="btn" style={{ background: 'var(--danger, #b42318)' }} onClick={() => { setConfirmDemote(false); void demote(); }} disabled={busy !== ''}>
                {c.visibility === 'Certified' ? 'Confirm revoke → Domain' : 'Confirm unshare → My'}
              </button>
              <button className="btn ghost" onClick={() => setConfirmDemote(false)} disabled={busy !== ''}>Cancel</button>
            </>
          ) : (
            <button className="btn ghost" onClick={() => setConfirmDemote(true)} disabled={busy !== ''}>
              {c.visibility === 'Certified' ? 'Revoke from Company' : 'Unshare'}
            </button>
          )
        ) : null}
        {/* Data-source toggle */}
        {!dataUsage ? (
          <button className="btn ghost" onClick={setUsage} disabled={busy !== ''}>
            {isDrive ? 'Index → Files' : 'Ingest → Bronze'}
          </button>
        ) : (
          <span className="hint" style={{ fontSize: 12, alignSelf: 'center' }}>
            Same connection — agent tool + {dataUsage === 'files' ? 'Files index' : 'Bronze source'}
          </span>
        )}
        {/* Lifecycle — Archive (live) · Restore + Delete (archived). Lives in the
            card action row next to Promote/Unshare so it's discoverable, consistent
            with every other tab (archived connections need the "Show archived"
            toggle above to be visible). */}
        {canManage ? (
          <span style={{ marginLeft: 'auto' }}>
            <LifecycleActions
              id={c.id}
              name={c.name}
              kind="connection"
              visibility={connVisibility(c.visibility)}
              archived={!!c.archived}
              api={`/api/connections/${c.id}`}
              onChanged={onChange}
              compact
            />
          </span>
        ) : null}
      </div>

      {msg ? <div className={msg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 10 }}>{msg}</div> : null}

      {/* Write-approval inline preview */}
      {approvalState ? (
        <div className="card" style={{ marginTop: 12, background: 'var(--panel)', borderColor: 'var(--gold-line)' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Write approval required</span>
            <span className="badge warn">⏸ held for review</span>
          </div>
          <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
            <strong>Action:</strong> {approvalState.preview.action}
            {' · '}requested by <span className="mono">{approvalState.preview.who}</span>
            {' · '}{approvalState.preview.reason}
          </div>
          {approvalState.preview.diff.length > 0 ? (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
                <tbody>
                  {approvalState.preview.diff.map((d, i) => (
                    <tr key={i}>
                      <td className="mono">{d.field}</td>
                      <td className="muted mono">{String(d.before ?? '—')}</td>
                      <td className="mono" style={{ color: 'var(--gold-text)' }}>{String(d.after ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 10, gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={denyApproval} disabled={busy !== ''}>
              Deny
            </button>
            <button className="btn ghost" onClick={approveOnce} disabled={busy !== ''}>
              Approve once
            </button>
            <button className="btn" onClick={approveRemember} disabled={busy !== ''}>
              Approve &amp; remember
            </button>
          </div>
          <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 11.5 }}>
            <strong>Approve &amp; remember</strong> creates a standing policy — identical calls auto-run without review.
          </p>
        </div>
      ) : null}

      {/* Capabilities table + autonomous preset */}
      {open ? (
        <div style={{ marginTop: 12 }}>
          {/* OS-wide rule: lifecycle lives inside the opened detail (the expanded
              capabilities view) — live → Archive + Version; archived → Restore +
              Delete + Version. `c.archived` carries the real state so Delete is
              reachable only after archiving. */}
          {canManage ? (
            <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <LifecycleActions
                id={c.id}
                name={c.name}
                kind="connection"
                visibility={connVisibility(c.visibility)}
                archived={!!c.archived}
                api={`/api/connections/${c.id}`}
                onChanged={onChange}
                compact
              />
            </div>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Tool</th><th>Mode</th><th>Limits</th><th></th></tr>
              </thead>
              <tbody>
                {draft.map((t, i) => (
                  <tr key={t.name}>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>{t.name}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{t.description}</div>
                    </td>
                    <td>
                      {canManage ? (
                        <select
                          value={t.mode}
                          onChange={(e) => {
                            const next = [...draft];
                            next[i] = { ...t, mode: e.target.value as CapabilityMode };
                            setDraft(next);
                          }}
                        >
                          {CAPABILITY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      ) : (
                        <span className={modeBadge(t.mode)}>{t.mode}</span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {t.limits?.maxAmount !== undefined ? `≤ ${t.limits.maxAmount}` : ''}
                      {t.limits?.dataScope ? ` · ${t.limits.dataScope}` : ''}
                      {t.limits?.rateLimitPerMin ? ` · ${t.limits.rateLimitPerMin}/min` : ''}
                    </td>
                    <td>
                      <button
                        className="btn ghost"
                        style={{ padding: '3px 9px' }}
                        onClick={() => tryTool(t.name)}
                        disabled={busy !== ''}
                      >
                        Try
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canManage ? (
              <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={saveCaps} disabled={busy !== ''}>
                  Save capability profile
                </button>
              </div>
            ) : null}
          </div>

          {/* Attach to a specific agent (grant, restrict-only) — Builder/Admin only */}
          {canManage ? (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div
                className="mono"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-faint)', marginBottom: 8 }}
              >
                Attach to an agent
              </div>
              <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                Grant this connection to one agent — it only ever sees the connections a Builder
                explicitly attaches. <strong>Read-only</strong> exposes just the Read tools even when
                the connection allows writes; a grant can only narrow, never broaden.
              </p>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={grantAgent}
                  onChange={(e) => setGrantAgent(e.target.value)}
                  placeholder="Agent principal (e.g. sales-assistant)"
                  style={{ flex: '2 1 140px' }}
                />
                <select
                  value={grantScope}
                  onChange={(e) => setGrantScope(e.target.value as 'read-only' | 'full')}
                  style={{ flex: '1 1 120px' }}
                >
                  <option value="read-only">read-only</option>
                  <option value="full">full (exposed tools)</option>
                </select>
                <button className="btn ghost" onClick={attachAgent} disabled={grantBusy || !grantAgent.trim()}>
                  {grantBusy ? <span className="spin" /> : 'Attach'}
                </button>
              </div>
              {grantMsg ? (
                <div className={grantMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 8 }}>
                  {grantMsg}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Autonomous safety preset — Builder/Admin only */}
          {canManage ? (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div
                className="mono"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-faint)', marginBottom: 8 }}
              >
                Autonomous agent safety preset
              </div>
              <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                Set how much freedom an agent has when running this connection autonomously.
                {' '}<strong>read-only</strong>: reads only.{' '}
                <strong>read-propose</strong>: reads freely, proposes writes for review.{' '}
                <strong>read-bounded</strong>: reads + writes within capability limits.{' '}
                <strong>full-in-scope</strong>: all enabled tools.{' '}
                Out-of-policy actions are blocked and queued to the Governance inbox.
              </p>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={agentPrincipal}
                  onChange={(e) => setAgentPrincipal(e.target.value)}
                  placeholder="Agent principal (e.g. sales-assistant)"
                  style={{ flex: '2 1 140px' }}
                />
                <select
                  value={autonomousPreset}
                  onChange={(e) => setAutonomousPreset(e.target.value as AutonomousPreset)}
                  style={{ flex: '1 1 130px' }}
                >
                  {AUTONOMOUS_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <button
                  className="btn ghost"
                  onClick={setPreset}
                  disabled={presetBusy || !agentPrincipal.trim()}
                >
                  {presetBusy ? <span className="spin" /> : 'Set preset'}
                </button>
              </div>
              {autonomousMsg ? (
                <div className={autonomousMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 8 }}>
                  {autonomousMsg}
                </div>
              ) : null}

              {/* Run autonomously — try the first few tools as the configured agent */}
              {draft.length > 0 ? (
                <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Run autonomously as <span className="mono">{agentPrincipal || 'agent'}</span>:
                  </span>
                  {draft.slice(0, 3).map((t) => (
                    <button
                      key={t.name}
                      className="btn ghost"
                      style={{ padding: '3px 9px', fontSize: 12 }}
                      onClick={() => tryTool(t.name, { asAgent: agentPrincipal, autonomous: true })}
                      disabled={busy !== ''}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function GovernedConnections() {
  return (
    <Suspense>
      <GovernedConnectionsInner />
    </Suspense>
  );
}
