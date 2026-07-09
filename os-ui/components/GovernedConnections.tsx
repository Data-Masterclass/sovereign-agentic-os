/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CAPABILITY_MODES, type CapabilityMode, type ConnectionTemplateKey } from '@/lib/connections/schema';
import { roleAtLeast, type Role } from '@/lib/session';
import { SCOPE_GROUPS, groupByScope, groupsFromVisibility, scopeCounts, type ScopeKey } from '@/lib/scopes';
import { providerForTemplate, providerConfig, type OAuthProvider } from '@/lib/oauth/providers';
import { driveConnectionStatus, driveAuthorizePath } from '@/lib/oauth/drive-status';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility } from '@/lib/lifecycle';
import DomainTag from '@/components/DomainTag';
import { CONNECTORS, CONNECTOR_CATEGORIES } from '@/lib/connections/connectors';
import { useApi } from '@/lib/useApi';

/**
 * Governed Connections surface — ONE scroll, no sub-tabs.
 *
 * Layout (top → bottom):
 *   1. Governed connections grouped All · My · Shared · Marketplace (scope switcher).
 *   2. Create a new connection (OAuth templates + service connectors).
 *   3. App MCP connections (auto-generated from Software tab).
 *   4. Supported connector catalog.
 *   5. Outbound access / egress allowlist (Builder/Admin only).
 *
 * Builder/Admin creates a Connection → endpoint + credential (to Secrets Manager,
 * never the record) → tests it → tunes the per-tool capability profile → promotes it
 * up the Personal→Shared→Marketplace ladder. Participants see a read-only consume view.
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
type Data = {
  user: { id: string; role: Role };
  connections: Conn[];
  templates: Template[];
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

export default function GovernedConnections() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>('');
  const [scope, setScope] = useState<ScopeKey>('all');
  const [showArchived, setShowArchived] = useState(false);

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

  // ---- New connection form ----
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('notion-mcp');
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [openApiSpec, setOpenApiSpec] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState('');

  const tpl = data?.templates.find((t) => t.key === template);
  const isOAuth = tpl?.auth === 'oauth';
  const isApiConnector = tpl?.connector === 'api';
  const oauthTemplates = data?.templates.filter((t) => t.auth === 'oauth') ?? [];
  const serviceTemplates = data?.templates.filter((t) => t.auth === 'service') ?? [];
  const canCreate = data?.canCreate ?? false;
  const canCreatePersonal = data?.canCreatePersonal ?? false;

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateMsg('');
    try {
      const body: Record<string, unknown> = { name, template };
      if (!isOAuth) {
        body.endpoint = endpoint;
        body.credential = credential;
        if (isApiConnector && openApiSpec.trim()) {
          let spec: unknown = openApiSpec.trim();
          try { spec = JSON.parse(openApiSpec.trim()); } catch { /* send raw — backend tolerates */ }
          body.openApiSpec = spec;
        }
      }
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const resp = await res.json() as { connection?: Conn; error?: string };
      if (!res.ok || !resp.connection) {
        setCreateMsg(`✗ ${resp.error ?? 'Could not create connection'}`);
      } else {
        const c = resp.connection;
        const ref = `${c.secretRef.name}/${c.secretRef.key}`;
        if (isOAuth) {
          setCreateMsg(`✓ Created "${c.name}" — ${c.visibility === 'Shared' ? 'Shared in Domain' : c.visibility}. Now click Connect on its card below to sign in and authorize your own account. The token goes to Secrets Manager as ref ${ref} (never the value).`);
        } else {
          setCreateMsg(`✓ Created "${c.name}" — ${c.visibility === 'Shared' ? 'Shared in Domain' : c.visibility}. Credential stored as ref ${ref} (never the value).`);
        }
        setName('');
        setCredential('');
        setOpenApiSpec('');
        load();
      }
    } catch (e) { setCreateMsg(`✗ ${(e as Error).message}`); }
    finally { setCreating(false); }
  }

  const showOAuthForm = (canCreatePersonal || canCreate) && isOAuth && oauthTemplates.length > 0;
  const showServiceForm = canCreate && !isOAuth && serviceTemplates.length > 0;

  if (!data && !error) return <div className="hint"><span className="spin" /> Loading connections…</div>;

  return (
    <ConfirmProvider>

      {/* ── 1. Governed connections (scope-grouped) ── */}
      <div className="section-title">
        Governed connections
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px', opacity: showArchived ? 1 : 0.7 }}
          onClick={() => setShowArchived((v) => !v)}
          title="Archived connections are hidden by default"
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}

      {(() => {
        if (!data) return null;
        const groups = groupsFromVisibility(data.connections);
        const scoped = groupByScope(groups, data.user.id);
        const counts = scopeCounts(groups, data.user.id);
        const visible = scoped[scope];
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
            {visible.length === 0 ? (
              <div className="stub-page">
                {scope === 'mine' || scope === 'all'
                  ? <>No governed connections yet{canCreate ? ' — create one below.' : '.'}</>
                  : scope === 'shared' ? 'Nothing shared in your domain yet.' : 'Nothing in the marketplace yet.'}
              </div>
            ) : (
              visible.map((c) => (
                <ConnectionCard
                  key={c.id}
                  c={c}
                  role={data.user.role}
                  oauthProviders={data.oauthProviders ?? []}
                  open={open === c.id}
                  onToggle={() => setOpen(open === c.id ? '' : c.id)}
                  onChange={load}
                />
              ))
            )}
          </>
        );
      })()}

      {/* ── 2. Create a new connection ── */}
      <div className="section-title" style={{ marginTop: 28 }}>New connection</div>
      {(canCreate || canCreatePersonal) ? (
        <>
          <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
            Pick a connector: <strong>Google Drive</strong>, <strong>OneDrive</strong> or
            {' '}<strong>Notion</strong>. Each connects with your own account via OAuth — you sign in,
            we complete the flow server-side and store only a token <em>reference</em> (never the token).
            All external endpoints are checked against the <strong>egress allowlist</strong>.
          </p>

          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Connection name (e.g. Alex's Google Drive, My Notion workspace)"
          />

          <div className="row" style={{ marginTop: 10 }}>
            <select
              value={template}
              onChange={(e) => { setTemplate(e.target.value); setEndpoint(''); }}
              style={{ flex: 1 }}
            >
              {oauthTemplates.length > 0 && (
                <optgroup label="Connect your own account (personal OAuth)">
                  {oauthTemplates.map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </optgroup>
              )}
              {serviceTemplates.length > 0 && (
                <optgroup label="Shared in Domain connection (service credentials — Builder / Admin)">
                  {serviceTemplates.map((t) => (
                    <option key={t.key} value={t.key}>{t.label} · {t.type}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          {showOAuthForm ? (
            <>
              <p className="hint" style={{ marginTop: 10, marginBottom: 6 }}>
                Add the drive, then click <strong>Connect</strong> on its card above to sign in through
                {tpl ? ` ${tpl.label}` : ' the provider'} and authorize your own account. We complete OAuth
                and store the token in Secrets Manager — never in the browser or the record. This
                connection is private to you (<strong>Personal</strong>).
              </p>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={create} disabled={creating || !name.trim()}>
                  {creating ? <span className="spin" /> : `Add ${tpl?.label ?? 'drive'}`}
                </button>
              </div>
            </>
          ) : showServiceForm ? (
            <>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder={tpl ? `Endpoint (e.g. ${tpl.endpointHint})` : 'Endpoint'}
                style={{ marginTop: 10 }}
              />
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder="Credential (API key / token / password) — goes to Secrets Manager"
                style={{ marginTop: 10 }}
                autoComplete="off"
              />
              {isApiConnector ? (
                <textarea
                  value={openApiSpec}
                  onChange={(e) => setOpenApiSpec(e.target.value)}
                  placeholder="Optional: paste OpenAPI spec (JSON or YAML) — governed tools are generated from it"
                  style={{ marginTop: 10, minHeight: 80, fontSize: 12, resize: 'vertical' }}
                />
              ) : null}
              <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={create} disabled={creating || !name.trim()}>
                  {creating ? <span className="spin" /> : 'Create connection'}
                </button>
              </div>
            </>
          ) : !canCreate && !isOAuth ? (
            <p className="hint" style={{ marginTop: 10 }}>
              Shared connections require a <strong>Builder</strong> or <strong>Administrator</strong>.
              Select a personal OAuth type above.
            </p>
          ) : null}

          {createMsg ? (
            <div className={createMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>
              {createMsg}
            </div>
          ) : null}
        </>
      ) : (
        <div className="stub-page">
          Creating connections requires a <strong>Builder</strong> or <strong>Administrator</strong>.
          You consume connections that have been granted or shared to you.
        </div>
      )}

      {/* ── 3. App MCP connections (auto-generated) ── */}
      <div className="section-title" style={{ marginTop: 28 }}>App MCP connections</div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Every app you build in the Software tab auto-generates an MCP, registered here as a
        governed connection + agent tool. Building an app and creating a connection are one act.
      </p>
      {(appConns?.connections?.length ?? 0) === 0 ? (
        <div className="stub-page">No app connections yet — build one in the Software tab.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Connection</th><th>Principal</th><th>Tools</th><th>Visibility</th><th>App</th></tr>
            </thead>
            <tbody>
              {appConns!.connections.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="mono">{c.principal}</td>
                  <td className="muted mono" style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.tools.map((t) => t.name).join(', ')}>{c.tools.map((t) => t.name).join(', ')}</td>
                  <td><span className={`badge vis-${c.visibility.toLowerCase()}`}>{c.visibility === 'Shared' ? 'Shared in Domain' : c.visibility}</span></td>
                  <td><Link className="btn ghost" href={`/software/${c.appId}`}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 4. Supported connector catalog ── */}
      <div className="section-title" style={{ marginTop: 28 }}>Supported connectors</div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        These connectors are wired end-to-end: you sign in with your own account and only a
        token <em>reference</em> is stored (never a raw secret). Connect any of them using
        the <strong>New connection</strong> form above.
      </p>
      {CONNECTOR_CATEGORIES.map((cat) => {
        const items = CONNECTORS.filter((c) => c.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} style={{ marginBottom: 18 }}>
            <div className="mono" style={{ color: 'var(--text-faint)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{cat}</div>
            <div className="grid">
              {items.map((c) => (
                <div className="card" key={c.name}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ margin: 0 }}>{c.name}</h3>
                    <span className="badge ok">available</span>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>Auth: {c.auth}</div>
                  <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                    <button
                      className="btn ghost"
                      onClick={() => {
                        // Scroll to the new connection form above (smooth UX).
                        document.querySelector<HTMLElement>('input[placeholder*="Connection name"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        setTemplate(c.template);
                      }}
                    >
                      Connect →
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* ── 5. Outbound access (Builder/Admin only) ── */}
      {canCreate ? <EgressSection /> : null}

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

function ConnectionCard({
  c, role, oauthProviders, open, onToggle, onChange,
}: {
  c: Conn; role: Role; oauthProviders: OAuthProviderStatus[]; open: boolean; onToggle: () => void; onChange: () => void;
}) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
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

  const canManage = roleAtLeast(role, 'builder');
  const exposed = c.tools.filter((t) => t.mode === 'Read' || t.mode === 'Write-approval' || t.mode === 'Write-bounded');
  const isDrive = c.connector === 'drive' || c.type === 'Drive';

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
    setMsg(r.ok ? `✓ Promoted to ${conn?.visibility ?? ''}` : `✗ ${r.data.error as string}`);
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
          <span className={badge(c.visibility)}>{c.visibility === 'Shared' ? 'Shared in Domain' : c.visibility}</span>
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

      {/* Action buttons */}
      <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
        {driveProvider || isNotion ? null : c.health === 'needs-reconnect'
          ? <button className="btn ghost" onClick={test} disabled={busy !== ''}>Reconnect</button>
          : <button className="btn ghost" onClick={test} disabled={busy !== ''}>Test</button>}
        <button className="btn ghost" onClick={onToggle}>
          {open ? 'Hide capabilities' : 'Capabilities'}
        </button>
        {canManage && c.visibility !== 'Certified' ? (
          <button className="btn ghost" onClick={promote} disabled={busy !== ''}>
            {c.visibility === 'Personal' ? 'Promote → Shared' : 'List → Marketplace'}
          </button>
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
