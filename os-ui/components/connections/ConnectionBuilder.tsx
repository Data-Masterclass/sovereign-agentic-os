/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <ConnectionBuilder /> — the Connections tab's View/Edit surface, matching the OS-wide
 * artifact model shipped on Metrics + Dashboards.
 *
 *   • A NEW connection (existing === null) opens on a TYPE CHOOSER with exactly two doors:
 *       – "Use a connector"        → the connector-template gallery (grouped + search),
 *                                     rides list_connection_templates; Connect → EDIT.
 *       – "Build a custom connector" → the from-scratch API/MCP path; Add → the connection
 *                                     lands live and opens in VIEW.
 *     Both land in the shared ConnectorWizard (the EDIT/configure surface for that choice).
 *
 *   • An EXISTING connection opens in VIEW: real status (live/failing — from the connection's
 *     own health + the governed Test capability, never invented), what it connects to, the
 *     capabilities/tools it exposes, and usage notes. A "Test connection" read-side health act
 *     lives in View. Promote + lifecycle live in the detail HEADER.
 *
 *   • "✎ Edit" (edit-scope gated via canManageArtifact) opens the configure surface: the
 *     per-tool capability profile, agent grants, autonomous safety presets, the data-source
 *     toggle, and the OAuth connect controls (Drive/Notion/warehouse register). Credentials
 *     stay secret-safe exactly as today — stored secrets are NEVER echoed. Save returns to View.
 *
 * All handlers + governed routes are unchanged from the previous inline card — this is a
 * reshape of the SAME behaviour into View/Edit, not a rewrite.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CAPABILITY_MODES, type CapabilityMode, type ConnectionTemplateKey } from '@/lib/connections/schema';
import { isOperationalTemplate, operationalPlatformFor, templateHasActionTools } from '@/lib/connections/operational-platform';
import { type Role, roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import { providerForTemplate, providerConfig, type OAuthProvider } from '@/lib/oauth/providers';
import { driveConnectionStatus, driveAuthorizePath } from '@/lib/oauth/drive-status';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton from '@/components/lifecycle/PromoteButton';
import DomainTag from '@/components/DomainTag';
import { WarehouseBrowser } from '@/components/data/WarehouseImportPanel';
import ConnectorWizard, { type WizardStart, type WizardData } from '@/components/connections/ConnectorWizard';
import ConnectorGallery from '@/components/connections/ConnectorGallery';
import ExposePanel from '@/components/connections/ExposePanel';
import { connectorIdentity, markStyle } from '@/lib/connections/connector-identity';
import type { CSSProperties } from 'react';
import {
  type Conn, type Tool, type Data, type EgressRequest, type ApprovalPreview, type OAuthProviderStatus,
  badge, modeBadge, visWord, connVisibility, ladderTier, postJSON, looksLikeEndpoint, ENDPOINT_LOOKS_WRONG,
} from './shared';

const AUTONOMOUS_PRESETS = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'] as const;
type AutonomousPreset = typeof AUTONOMOUS_PRESETS[number];

/** How a new connection's create flow was entered (drives the two-door chooser). */
type NewDoor = null | { door: 'connector'; start?: WizardStart } | { door: 'custom' };

// ---- Main component --------------------------------------------------------

export default function ConnectionBuilder({
  existing,
  data,
  onBack,
  onChanged,
}: {
  /** Open an existing connection (lands at View), or null to create a new one (type chooser). */
  existing: Conn | null;
  /** The one /api/connections payload (templates, warehouse meta, oauth providers, gates). */
  data: Data;
  onBack: () => void;
  /** Re-fetch the list after any mutation (create, promote, capability save, …). */
  onChanged: () => void;
}) {
  const canOpen = data.canCreate || data.canCreatePersonal;
  // For a NEW connection, which door the builder is on (null = the chooser itself).
  const [door, setDoor] = useState<NewDoor>(null);

  // ── NEW connection: the two-door type chooser ──
  if (!existing) {
    return (
      <div>
        <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
          <button className="btn ghost sm" onClick={door ? () => setDoor(null) : onBack}>
            {door ? '← Choose a different way' : '← All connections'}
          </button>
        </div>

        {door === null ? (
          <TypeChooser canOpen={canOpen} onPick={(d) => setDoor(d)} />
        ) : door.door === 'connector' && door.start ? (
          // A gallery card was picked → the shared wizard, pre-set to that type (Edit surface).
          <ConnectorWizard
            data={wizardData(data)}
            start={door.start}
            onDone={onChanged}
            onCancel={() => setDoor({ door: 'connector' })}
          />
        ) : door.door === 'connector' ? (
          // Door A: the connector-template gallery (grouped + search).
          <div>
            <div className="section-title" style={{ marginTop: 4 }}>Bring a connector</div>
            <ConnectorGallery
              templates={data.templates}
              warehouse={data.warehouse}
              canOpen={canOpen}
              onConnect={(start) => setDoor({ door: 'connector', start })}
            />
          </div>
        ) : (
          // Door B: build a custom connector (from scratch API/MCP + auto-egress).
          <CustomConnectorDoor onDone={onChanged} onCreated={onBack} />
        )}
      </div>
    );
  }

  // ── EXISTING connection: View / Edit ──
  return (
    <ConnectionDetail
      c={existing}
      user={data.user}
      oauthProviders={data.oauthProviders ?? []}
      actionsEnabled={data.operationalActionsEnabled ?? false}
      onBack={onBack}
      onChanged={onChanged}
    />
  );
}

/** Narrow the page payload to the wizard's prop shape. */
function wizardData(data: Data): WizardData {
  return { templates: data.templates, warehouse: data.warehouse, canCreate: data.canCreate, canCreatePersonal: data.canCreatePersonal };
}

// ---- Type chooser (two doors) ----------------------------------------------

/**
 * The two-door type chooser — the ONLY choice a new connection asks first: bring an existing
 * connector, or build one from scratch. Two calm, equal cards (Apple: one decision, no clutter).
 */
function TypeChooser({ canOpen, onPick }: { canOpen: boolean; onPick: (d: NewDoor) => void }) {
  if (!canOpen) {
    return (
      <div className="stub-page">
        You don&apos;t have permission to create connections. Ask a Builder or Domain admin to add one you can use.
      </div>
    );
  }
  return (
    <div>
      <h2 style={{ margin: '0 0 6px' }}>Connect a new source</h2>
      <p className="lead" style={{ marginTop: 0, maxWidth: 640 }}>
        Two ways in. Pick a ready-made connector, or wire up your own — either way it lands governed,
        with your credentials kept in the vault, never in the record.
      </p>
      <div className="conn-doors">
        <button
          type="button"
          className="conn-door conn-door--gold"
          onClick={() => onPick({ door: 'connector' })}
        >
          <span className="conn-door-mark" aria-hidden="true">◇</span>
          <div className="conn-door-eyebrow">Ready-made</div>
          <h3 className="conn-door-title">Bring a connector</h3>
          <p className="conn-door-sub">
            Pick from the gallery — your files, your CRM, your warehouse, your inbox and more.
            Sign in and it just works.
          </p>
          <span className="conn-door-cta">Browse the gallery <span className="arr" aria-hidden="true">→</span></span>
        </button>

        <button
          type="button"
          className="conn-door conn-door--teal"
          onClick={() => onPick({ door: 'custom' })}
        >
          <span className="conn-door-mark" aria-hidden="true">◆</span>
          <div className="conn-door-eyebrow">Your own</div>
          <h3 className="conn-door-title">Wire up your own</h3>
          <p className="conn-door-sub">
            Connect any REST or GraphQL API, or an MCP server, from scratch. Reading is on by
            default; anything that writes stays off until you allow it.
          </p>
          <span className="conn-door-cta">Start from scratch <span className="arr" aria-hidden="true">→</span></span>
        </button>
      </div>
    </div>
  );
}

// ---- Custom connector door -------------------------------------------------

/**
 * The "Build a custom connector" door — add an arbitrary API or MCP server as a governed
 * connection, with egress automatically requested in the same action. Same governed path as
 * before (POST /api/connections generic-api|generic-mcp + POST /api/egress). On success it
 * calls onDone (list re-fetch) and onCreated (return to the list, where the new connection
 * opens in View like every other tile).
 */
function CustomConnectorDoor({ onDone, onCreated }: { onDone: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<'api' | 'mcp'>('api');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgOk, setMsgOk] = useState(false);

  const [egressRequests, setEgressRequests] = useState<EgressRequest[]>([]);
  const [egressErr, setEgressErr] = useState('');

  const loadEgress = useCallback(async () => {
    try {
      const res = await fetch('/api/egress', { cache: 'no-store' });
      const body = await res.json() as { requests?: EgressRequest[]; error?: string };
      if (res.ok) setEgressRequests(body.requests ?? []);
      else setEgressErr(body.error ?? 'Failed to load egress requests');
    } catch (e) { setEgressErr((e as Error).message); }
  }, []);
  useEffect(() => { loadEgress(); }, [loadEgress]);

  const endpointHint = kind === 'api' ? 'https://api.example.com' : 'https://mcp.example.com/sse';

  async function handleAdd() {
    if (!name.trim() || !endpoint.trim() || busy) return;
    // Client-side URL-shape guard: never ship an obviously-non-URL (a pasted credential)
    // to the egress path, where the error would echo it back. Server stays the authority.
    if (!looksLikeEndpoint(endpoint)) { setMsg(`✗ ${ENDPOINT_LOOKS_WRONG}`); setMsgOk(false); return; }
    setBusy(true); setMsg(''); setMsgOk(false);
    try {
      // M5: file the egress request FIRST. The whole reason a custom connector needs an
      // egress request is that its host is NOT yet on the allowlist — in which case
      // POST /api/connections 403s on that very host and returns BEFORE we could ever
      // request egress. Requesting it first means the auto-request always fires in the
      // case it exists for; the user then retries the create once an Admin approves.
      const egressRes = await postJSON('/api/egress', {
        endpoint: endpoint.trim(),
        reason: `Custom ${kind === 'api' ? 'API' : 'MCP'} connector: ${name.trim()}`,
      });
      const connRes = await postJSON('/api/connections', {
        name: name.trim(),
        template: kind === 'api' ? 'generic-api' : 'generic-mcp',
        endpoint: endpoint.trim(),
        credential,
      });
      if (!connRes.ok) {
        // Create was refused — most commonly the host isn't on the egress allowlist yet.
        // The egress request is already filed, so tell the user to retry after approval
        // rather than losing the request they came here to make.
        const err = (connRes.data.error as string) ?? 'Could not create connection';
        const retryNote = egressRes.ok
          ? ' An egress request was filed — once an Admin approves the host in the Governance tab, add the connection again.'
          : '';
        setMsg(`✗ ${err}${retryNote}`);
        await loadEgress();
        return;
      }
      const egressNote = egressRes.ok ? ' Egress request submitted — pending Admin approval in the Governance tab.' : '';
      const connName = (connRes.data.connection as { name?: string })?.name ?? name.trim();
      setMsg(`✓ "${connName}" created.${egressNote}`);
      setMsgOk(true);
      setName(''); setEndpoint(''); setCredential('');
      onDone();
      await loadEgress();
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="section-title" style={{ marginTop: 4 }}>Wire up your own</div>
      <div className="card" style={{ marginBottom: 0 }}>
        {/* API / MCP choice */}
        <div style={{ display: 'inline-flex', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 16 }}>
          {(['api', 'mcp'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '5px 18px',
                fontSize: 12,
                fontFamily: 'var(--font-mono, monospace)',
                letterSpacing: '0.04em',
                background: kind === k ? 'var(--text)' : 'transparent',
                color: kind === k ? 'var(--bg, #fff)' : 'var(--text-faint)',
                transition: 'background 0.12s, color 0.12s',
                userSelect: 'none',
              }}
            >
              {k === 'api' ? 'REST / GraphQL API' : 'MCP server'}
            </button>
          ))}
        </div>

        {/* Fields */}
        <div style={{ display: 'grid', gap: 10 }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'api' ? 'Name (e.g. Stripe API)' : 'Name (e.g. Ops MCP)'} autoComplete="off" />
          <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={`Base URL (e.g. ${endpointHint})`} autoComplete="off" />
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={kind === 'api' ? 'API key or bearer token — goes to Secrets Manager, never echoed' : 'MCP auth token — goes to Secrets Manager, never echoed'}
            autoComplete="off"
          />
        </div>

        <p className="hint" style={{ marginTop: 10, marginBottom: 0, fontSize: 11.5 }}>
          Reads auto-allow; writes default to Off. Egress to the host is requested automatically and needs Admin approval.
        </p>

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
          {msgOk ? <button className="btn ghost" onClick={onCreated}>Done — back to connections</button> : null}
          <button className="btn" onClick={handleAdd} disabled={busy || !name.trim() || !endpoint.trim()}>
            {busy ? <span className="spin" /> : `Add ${kind === 'api' ? 'API' : 'MCP'} connector`}
          </button>
        </div>

        {msg ? <div className={msgOk ? 'answer' : 'error'} style={{ marginTop: 10 }}>{msg}</div> : null}
      </div>

      {/* Egress request status — pending/approved/rejected for this domain */}
      {egressErr ? <div className="error" style={{ marginTop: 8 }}>{egressErr}</div> : null}
      {egressRequests.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Host</th><th>Reason</th><th>Status</th></tr></thead>
            <tbody>
              {egressRequests.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.host}</td>
                  <td className="muted">{r.reason}</td>
                  <td><span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'err' : 'muted'}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ---- Connection detail (View / Edit) ---------------------------------------

/**
 * The View/Edit surface for one existing connection. VIEW is read-first — real status,
 * what it connects to, the capabilities it exposes, usage notes, and the read-side Test act.
 * EDIT (canManage) is the configure surface — capability profile, grants, autonomous presets,
 * data-source toggle, and OAuth connect controls. Header carries Rename · View⇄Edit · Promote
 * · Unshare · lifecycle. Every handler + route is unchanged from the old inline card.
 */
function ConnectionDetail({
  c, user, oauthProviders, actionsEnabled, onBack, onChanged,
}: {
  c: Conn;
  user: { id: string; role: Role; domains: string[] };
  oauthProviders: OAuthProviderStatus[];
  actionsEnabled: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const role = user.role;
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [confirmDemote, setConfirmDemote] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(c.name);
  const [draft, setDraft] = useState<Tool[]>(c.tools);
  const [approvalState, setApprovalState] = useState<{ tool: string; args: Record<string, unknown>; preview: ApprovalPreview } | null>(null);
  const [dataUsage, setDataUsage] = useState<'bronze' | 'files' | null>(c.dataUsage);
  const [grantAgent, setGrantAgent] = useState('sales-assistant');
  const [grantScope, setGrantScope] = useState<'read-only' | 'full'>('read-only');
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMsg, setGrantMsg] = useState('');
  const [agentPrincipal, setAgentPrincipal] = useState('sales-assistant');
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotateDraft, setRotateDraft] = useState('');
  const [autonomousPreset, setAutonomousPreset] = useState<AutonomousPreset>('read-only');
  const [presetBusy, setPresetBusy] = useState(false);
  const [autonomousMsg, setAutonomousMsg] = useState('');

  // Keep the editable draft in sync if the connection reloads (tools may change).
  useEffect(() => { setDraft(c.tools); }, [c.tools]);
  useEffect(() => { setDataUsage(c.dataUsage); }, [c.dataUsage]);

  // Fail-closed edit-scope (defense-in-depth; server is the authority): only owner,
  // owning-domain domain_admin, or admin sees manage controls.
  const canManage = canManageArtifact(user, { owner: c.owner, domain: c.domain });
  const canApprove = roleAtLeast(role, 'builder');
  const exposed = c.tools.filter((t) => t.mode === 'Read' || t.mode === 'Write-approval' || t.mode === 'Write-bounded');
  const isDrive = c.connector === 'drive' || c.type === 'Drive';
  const isWarehouse = c.template === 'warehouse';
  const isOperational = isOperationalTemplate(c.template as ConnectionTemplateKey);
  const isNotion = c.template === 'notion-mcp';
  // M13: a SERVICE-credential connection (a pasted token/key) can have its credential
  // rotated over the same ref. Flow-based OAuth (Drive/Notion) uses Connect/Reconnect
  // instead, and a warehouse rotates via re-register — both excluded here.
  const canRotate = c.auth === 'service' && !isWarehouse && !isNotion;

  const notionStatus = driveConnectionStatus(c);
  const [notionTools, setNotionTools] = useState<{ name: string; description?: string }[] | null>(null);
  const [notionMsg, setNotionMsg] = useState('');

  const driveProvider: OAuthProvider | null = isDrive && c.auth === 'oauth'
    ? providerForTemplate(c.template as ConnectionTemplateKey)
    : null;
  const driveProviderStatus = driveProvider ? oauthProviders.find((p) => p.provider === driveProvider) : undefined;
  const driveProviderConfigured = driveProviderStatus?.configured ?? false;
  const driveProviderLabel = driveProvider ? providerConfig(driveProvider).label : '';
  const driveStatus = driveConnectionStatus(c);

  function connectNotion() { window.location.href = `/api/connections/notion/authorize?connectionId=${encodeURIComponent(c.id)}`; }
  function connectDrive() { if (driveProvider) window.location.href = driveAuthorizePath(driveProvider, c.id); }

  async function verifyNotion() {
    setBusy('verify-notion'); setNotionMsg('');
    try {
      const r = await postJSON(`/api/connections/${c.id}/mcp-tools`);
      const detail = (r.data.detail as string) ?? (r.data.error as string) ?? 'Verification failed';
      setNotionMsg(`${r.data.ok ? '✓' : '✗'} ${detail}`);
      setNotionTools((r.data.tools as { name: string; description?: string }[]) ?? []);
      if (r.data.ok) onChanged();
    } catch (e) { setNotionMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(''); }
  }

  async function disconnect(kind: 'drive' | 'notion') {
    if (typeof window !== 'undefined' && !window.confirm(`Disconnect "${c.name}"? This removes the connection and its stored token.`)) return;
    setBusy('disconnect');
    (kind === 'notion' ? setNotionMsg : setMsg)('');
    try {
      const res = await fetch(`/api/connections/${c.id}`, { method: 'DELETE' });
      if (res.ok) { onChanged(); onBack(); return; }
      const d = await res.json() as { error?: string };
      (kind === 'notion' ? setNotionMsg : setMsg)(`✗ ${d.error ?? 'Could not disconnect'}`);
    } catch (e) { (kind === 'notion' ? setNotionMsg : setMsg)(`✗ ${(e as Error).message}`); }
    finally { setBusy(''); }
  }

  async function doPost(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    setBusy(path); setMsg('');
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
    // Branch on the PAYLOAD's ok, not the HTTP status — the route always returns 200
    // even on credential/connectivity failure, with ok:false. Real result, loud.
    setMsg((r.data.ok as boolean)
      ? `✓ ${r.data.detail as string}`
      : `✗ ${(r.data.error as string) ?? (r.data.detail as string)}`);
    if (r.data.ok) onChanged();
  }

  async function demote() {
    const r = await doPost(`/api/connections/${c.id}/demote`);
    const conn = r.data.connection as Conn | undefined;
    setMsg(r.ok ? `✓ Revoked → ${conn ? visWord(conn.visibility) : ''}` : `✗ ${r.data.error as string}`);
    if (r.ok) onChanged();
  }

  async function submitRename() {
    const name = renameDraft.trim();
    if (!name || name === c.name) { setRenaming(false); return; }
    const r = await doPost(`/api/connections/${c.id}`, { action: 'rename', name });
    if (r.ok) { setRenaming(false); onChanged(); }
    else setMsg(`✗ ${(r.data.error as string) ?? 'Rename failed'}`);
  }

  async function saveCaps() {
    const updates = draft.map((t) => ({ name: t.name, mode: t.mode, limits: t.limits }));
    const r = await doPost(`/api/connections/${c.id}/capabilities`, { updates });
    setMsg(r.ok ? '✓ Capability profile saved + recompiled into OPA policy' : `✗ ${r.data.error as string}`);
    if (r.ok) { onChanged(); setMode('view'); }
  }

  async function setUsage() {
    const usage = isDrive ? 'files' : 'bronze';
    const r = await doPost(`/api/connections/${c.id}/usage`, { usage });
    if (r.ok) { const updated = r.data.connection as Conn | undefined; setDataUsage(updated?.dataUsage ?? usage); onChanged(); }
    else setMsg(`✗ ${r.data.error as string}`);
  }

  async function rotateCredential() {
    const credential = rotateDraft;
    if (!credential.trim()) { setMsg('✗ Paste the new credential first'); return; }
    const r = await doPost(`/api/connections/${c.id}`, { action: 'rotate-credential', credential });
    if (r.ok) {
      setRotateOpen(false); setRotateDraft('');
      setMsg('✓ Credential rotated — status is now Untested; run Test connection to verify.');
      onChanged();
    } else setMsg(`✗ ${(r.data.error as string) ?? 'Rotate failed'}`);
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
      // HONESTY (C2): if the executor returned an offline-mock envelope, say so in the
      // result line — never let a demonstration fixture read as a live call.
      const mock = (d.result as { mode?: string } | undefined)?.mode === 'offline-mock'
        ? ' · offline-mock (demonstration data — no live call was made)'
        : '';
      setMsg(`${icon} ${toolName}: ${d.decision as string} — ${(d.reason ?? d.error) as string}${tail}${mock}`);
      if (d.decision === 'requires_approval') onChanged();
    }
  }

  async function approveOnce() {
    if (!approvalState) return;
    const { tool, args } = approvalState;
    const r = await doPost(`/api/connections/${c.id}/approve`, { tool, args });
    const d = r.data;
    setApprovalState(null);
    setMsg(r.ok ? `✓ ${tool}: approved inline and executed once — ${(d.reason ?? '') as string}` : `✗ ${(d.error ?? d.reason) as string}`);
    if (r.ok) onChanged();
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
    setMsg(r.ok ? '✓ Standing policy created — identical calls now auto-run' : `✗ ${r.data.error as string}`);
  }

  async function attachAgent() {
    if (!grantAgent.trim() || grantBusy) return;
    setGrantBusy(true); setGrantMsg('');
    const r = await postJSON(`/api/connections/${c.id}/grant`, { agent: grantAgent.trim(), scope: grantScope });
    setGrantMsg(r.ok
      ? `✓ Attached to ${grantAgent.trim()} (${grantScope}) — other agents don't see this connection`
      : `✗ ${r.data.error as string}`);
    setGrantBusy(false);
    if (r.ok) onChanged();
  }

  async function setPreset() {
    if (!agentPrincipal.trim() || presetBusy) return;
    setPresetBusy(true); setAutonomousMsg('');
    const r = await postJSON(`/api/connections/${c.id}/autonomous`, { agent: agentPrincipal.trim(), preset: autonomousPreset });
    setAutonomousMsg(r.ok ? `✓ Preset "${autonomousPreset}" applied to ${agentPrincipal.trim()}` : `✗ ${r.data.error as string}`);
    setPresetBusy(false);
  }

  const canRevoke = (c.visibility === 'Certified' && role === 'admin') || (c.visibility === 'Shared' && canManage);
  const identity = connectorIdentity(c.template, { label: c.name });

  return (
    <div>
      {/* ── Header: back · Rename · badges · View⇄Edit · Promote · Unshare · lifecycle ── */}
      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onBack}>← All connections</button>
      </div>

      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span className="conn-mono sm" aria-hidden="true" style={markStyle(identity.accent) as CSSProperties}>{identity.monogram}</span>
        {renaming ? (
          <span className="rename-inline">
            <input
              className="rename-input"
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitRename(); if (e.key === 'Escape') { setRenaming(false); setRenameDraft(c.name); } }}
              aria-label="Connection name"
            />
            <button className="btn primary sm" onClick={() => void submitRename()} disabled={busy !== ''}>Save</button>
            <button className="btn ghost sm" onClick={() => { setRenaming(false); setRenameDraft(c.name); }}>Cancel</button>
          </span>
        ) : (
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            {c.name}
            {canManage ? (
              <button
                className="btn ghost sm"
                style={{ flex: 'none' }}
                onClick={() => { setRenameDraft(c.name); setRenaming(true); }}
                title="Rename (display name only — the physical identity is frozen)"
                aria-label="Rename this connection"
              >✎ Rename</button>
            ) : null}
          </h2>
        )}
        <span className="badge muted">{c.type}</span>
        <HealthBadge health={c.health} />
        {dataUsage === 'bronze' ? <span className="badge warn">Bronze source{c.dataUsageMode === 'offline-mock' ? ' (mock)' : ''}</span> : null}
        {dataUsage === 'files' ? <span className="badge warn">Files index{c.dataUsageMode === 'offline-mock' ? ' (mock)' : ''}</span> : null}
        {c.archived ? <span className="badge muted">archived</span> : null}
        {(c.visibility === 'Shared' || c.visibility === 'Certified') ? <DomainTag domain={c.domain} /> : null}
        <span className={badge(c.visibility)}>{visWord(c.visibility)}</span>

        {canManage ? (
          <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {mode === 'view'
              ? <button className="btn ghost sm" onClick={() => setMode('edit')} title="Edit this connection's configuration">✎ Edit</button>
              : <button className="btn ghost sm" onClick={() => setMode('view')} title="Back to the read view">View</button>}
            {c.visibility !== 'Certified' ? (
              <PromoteButton
                id={c.id}
                kind="connection"
                tier={ladderTier(c.visibility)}
                promoteUrl={`/api/connections/${c.id}/promote`}
                canApprove={canApprove}
                onDone={onChanged}
              />
            ) : null}
            {canRevoke ? (
              confirmDemote ? (
                <>
                  <button className="btn sm" style={{ background: 'var(--danger, #b42318)' }} onClick={() => { setConfirmDemote(false); void demote(); }} disabled={busy !== ''}>
                    {c.visibility === 'Certified' ? 'Confirm revoke → Domain' : 'Confirm unshare → My'}
                  </button>
                  <button className="btn ghost sm" onClick={() => setConfirmDemote(false)} disabled={busy !== ''}>Cancel</button>
                </>
              ) : (
                <button className="btn ghost sm" onClick={() => setConfirmDemote(true)} disabled={busy !== ''}>
                  {c.visibility === 'Certified' ? 'Revoke from Company' : 'Unshare'}
                </button>
              )
            ) : null}
            <LifecycleActions
              id={c.id}
              name={c.name}
              kind="connection"
              visibility={connVisibility(c.visibility)}
              archived={!!c.archived}
              api={`/api/connections/${c.id}`}
              onChanged={() => { onChanged(); onBack(); }}
              compact
            />
          </div>
        ) : null}
      </div>

      <div className="muted mono" style={{ marginBottom: 8, fontSize: 11.5 }}>{c.principal}</div>

      {msg ? <div className={msg.startsWith('✗') ? 'error' : 'answer'} style={{ marginBottom: 10 }}>{msg}</div> : null}

      {mode === 'edit' && canManage ? editSurface() : viewSurface()}
    </div>
  );

  // ── View surface — read-first: status · what it connects to · exposed capabilities · usage ──
  function viewSurface() {
    return (
      <div>
        {/* Status — real, from health + the governed Test act. Never invented. */}
        <div className="guided-panel" style={{ marginTop: 4 }}>
          <span className="comp-label" style={{ margin: 0 }}>Status</span>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <HealthBadge health={c.health} />
            {/* Drive / Notion connect status folds into the status line honestly. */}
            {driveProvider ? (
              driveStatus === 'connected' ? <span className="badge ok">Connected as {c.owner}</span>
                : driveStatus === 'needs-reconnect' ? <span className="badge err">Needs reconnect</span>
                : <span className="badge muted">Not connected</span>
            ) : null}
            {isNotion ? (
              notionStatus === 'connected' ? <span className="badge ok">Connected as {c.owner}</span>
                : notionStatus === 'needs-reconnect' ? <span className="badge err">Needs reconnect</span>
                : <span className="badge muted">Not connected</span>
            ) : null}
            {/* Test connection is a READ-side health act — reachable in View. Warehouse
                keeps its own Register→Test lifecycle in Edit; here we surface reachability. */}
            {!isWarehouse ? (
              <button className="btn ghost sm" onClick={test} disabled={busy !== ''}>
                {busy === `/api/connections/${c.id}/test` ? <span className="spin" /> : c.health === 'needs-reconnect' ? 'Test / Reconnect' : 'Test connection'}
              </button>
            ) : (
              <button className="btn ghost sm" onClick={test} disabled={busy !== ''}>
                {busy === `/api/connections/${c.id}/test` ? <span className="spin" /> : 'Test connection'}
              </button>
            )}
          </div>
        </div>

        {/* What it connects to */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>What it connects to</span>
          <div className="muted mono" style={{ marginTop: 10, fontSize: 11.5 }}>
            {c.connector} · {c.auth === 'oauth' ? 'signs in as you' : 'service account'} · {c.owner}/{c.domain}
            {c.endpoint ? <> · {c.endpoint}</> : null}
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
            Secret: <span className="mono">{c.secretRef.name}/{c.secretRef.key}</span>{' '}
            {c.secretSet ? <span className="badge ok">stored</span> : <span className="badge muted">none</span>}{' '}
            {c.secretFingerprint ? <span className="mono" style={{ fontSize: 11 }}>{c.secretFingerprint}</span> : null}
            <span style={{ marginLeft: 10 }}>
              Egress:{' '}
              {c.egress.external
                ? <span className={`badge ${c.egress.allowed ? 'ok' : 'err'}`}>{c.egress.host} {c.egress.allowed ? 'allowed' : 'blocked'}</span>
                : <span className="badge muted">internal</span>}
            </span>
          </div>
          {c.warehouse ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              Federated as Trino catalog <span className="mono">{c.warehouse.catalog}</span> ({c.warehouse.platform}).
              Register / Test / Browse live in <strong>✎ Edit</strong>.
            </p>
          ) : null}
          {c.visibility === 'Certified' ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              Marketplace template — consumers bring their own credentials.
            </p>
          ) : null}
        </div>

        {/* Capabilities / tools it exposes (read-only) */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>Capabilities it exposes to agents</span>
          {c.tools.length === 0 ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>No tools exposed yet.</p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Tool</th><th>Mode</th><th>Limits</th></tr></thead>
                <tbody>
                  {c.tools.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <div className="mono" style={{ fontWeight: 600 }}>{t.name}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{t.description}</div>
                      </td>
                      <td><span className={modeBadge(t.mode)}>{t.mode}</span></td>
                      <td className="muted" style={{ fontSize: 11.5 }}>
                        {t.limits?.maxAmount !== undefined ? `≤ ${t.limits.maxAmount}` : ''}
                        {t.limits?.dataScope ? ` · ${t.limits.dataScope}` : ''}
                        {t.limits?.rateLimitPerMin ? ` · ${t.limits.rateLimitPerMin}/min` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            Exposed tools: <span className="mono">{exposed.map((t) => t.name).join(', ') || '(none)'}</span>
            {c.grants.length ? <span style={{ marginLeft: 10 }}>· Attached to: {c.grants.map((g) => `${g.agent} (${g.scope})`).join(', ')}</span> : null}
          </p>
        </div>

        {/* Usage notes */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>Usage</span>
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            {dataUsage === 'files'
              ? 'This connection also feeds the Files index — the same connection, one act.'
              : dataUsage === 'bronze'
                ? 'This connection also feeds a Bronze source — the same connection, one act.'
                : isDrive
                  ? 'Can also index into Files — enable it in ✎ Edit.'
                  : 'Can also ingest into a Bronze source — enable it in ✎ Edit.'}
          </p>
        </div>
      </div>
    );
  }

  // ── Edit surface — configure: OAuth connect · caps profile · grants · autonomous · usage ──
  function editSurface() {
    return (
      <div>
        {/* Personal-drive connect controls (own account, own consent). */}
        {driveProvider ? (
          <div className="guided-panel" style={{ marginTop: 4 }}>
            <span className="comp-label" style={{ margin: 0 }}>Connect your {driveProviderLabel}</span>
            <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {driveStatus === 'connected' ? <span className="badge ok">Connected as {c.owner}</span>
                : driveStatus === 'needs-reconnect' ? <span className="badge err">Needs reconnect</span>
                : <span className="badge muted">Not connected</span>}
              {!driveProviderConfigured ? (
                <span className="hint" style={{ fontSize: 12 }}>An administrator must configure the {driveProviderLabel} OAuth app first.</span>
              ) : driveStatus === 'connected' ? (
                <>
                  <button className="btn ghost" onClick={connectDrive} disabled={busy !== ''}>Reconnect</button>
                  <button className="btn ghost" onClick={() => disconnect('drive')} disabled={busy !== ''}>Disconnect</button>
                </>
              ) : driveStatus === 'needs-reconnect' ? (
                <>
                  <button className="btn" onClick={connectDrive} disabled={busy !== ''}>Reconnect</button>
                  <button className="btn ghost" onClick={() => disconnect('drive')} disabled={busy !== ''}>Disconnect</button>
                </>
              ) : (
                <button className="btn" onClick={connectDrive} disabled={busy !== ''}>Connect {driveProviderLabel}</button>
              )}
            </div>
          </div>
        ) : null}

        {/* Notion hosted-MCP connect controls (own workspace, own consent). */}
        {isNotion ? (
          <div className="guided-panel" style={{ marginTop: 4 }}>
            <span className="comp-label" style={{ margin: 0 }}>Connect your Notion workspace</span>
            <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {notionStatus === 'connected' ? <span className="badge ok">Connected as {c.owner}</span>
                : notionStatus === 'needs-reconnect' ? <span className="badge err">Needs reconnect</span>
                : <span className="badge muted">Not connected</span>}
              {notionStatus === 'connected' ? (
                <>
                  <button className="btn ghost" onClick={verifyNotion} disabled={busy !== ''}>{busy === 'verify-notion' ? <span className="spin" /> : 'Verify · list tools'}</button>
                  <button className="btn ghost" onClick={connectNotion} disabled={busy !== ''}>Reconnect</button>
                  <button className="btn ghost" onClick={() => disconnect('notion')} disabled={busy !== ''}>Disconnect</button>
                </>
              ) : notionStatus === 'needs-reconnect' ? (
                <>
                  <button className="btn" onClick={connectNotion} disabled={busy !== ''}>Reconnect</button>
                  <button className="btn ghost" onClick={() => disconnect('notion')} disabled={busy !== ''}>Disconnect</button>
                </>
              ) : (
                <button className="btn" onClick={connectNotion} disabled={busy !== ''}>Connect Notion</button>
              )}
            </div>
            {notionMsg ? <div className={notionMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{notionMsg}</div> : null}
            {notionTools && notionTools.length > 0 ? (
              <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>Live tools: {notionTools.map((t) => t.name).join(', ')}</div>
            ) : null}
          </div>
        ) : null}

        {/* Warehouse lifecycle — Register → Test → Browse (its own block; no YAML). */}
        {isWarehouse ? (
          <div className="guided-panel" style={{ marginTop: 4 }}>
            <span className="comp-label" style={{ margin: 0 }}>Warehouse catalog</span>
            <WarehouseControls c={c} canManage={canManage} onChange={onChanged} />
          </div>
        ) : null}

        {/* Expose to domains — admin-only (exposure is a Company-tier act). Compiles
            each listed table to an OPA governance entry shared with the chosen domains. */}
        {isWarehouse && c.warehouse && role === 'admin' ? (
          <ExposePanel connectionId={c.id} catalog={c.warehouse.catalog} />
        ) : null}

        {/* Expose operational ENTITIES (Salesforce/Kajabi) — same admin gate; the panel
            locks mode to Sync (no Trino catalog exists to federate a live read). */}
        {isOperational && role === 'admin' ? (
          <ExposePanel connectionId={c.id} catalog={operationalPlatformFor(c.template as ConnectionTemplateKey) ?? c.template} operational actionsEnabled={actionsEnabled && templateHasActionTools(c.template as ConnectionTemplateKey)} />
        ) : null}

        {/* Data-source toggle */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>Use as a data source</span>
          <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!dataUsage ? (
              <button className="btn ghost" onClick={setUsage} disabled={busy !== ''}>{isDrive ? 'Index → Files' : 'Ingest → Bronze'}</button>
            ) : (
              <span className="hint" style={{ fontSize: 12 }}>Same connection — agent tool + {dataUsage === 'files' ? 'Files index' : 'Bronze source'}</span>
            )}
          </div>
          {dataUsage && c.dataUsageMode === 'offline-mock' ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 11.5 }}>
              ⚠︎ Registered as an <strong>offline mock</strong> — the row/item count is a deterministic stand-in, not a real ingest. The live dlt/Drive sync isn't wired on this deployment yet.
            </p>
          ) : null}
        </div>

        {/* Credential rotation (M13) — re-supply an expired/rotated service credential
            over the SAME vault ref, keeping grants + exposures. */}
        {canRotate ? (
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>Credential</span>
            <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {c.health === 'needs-reconnect' ? <span className="badge err">Needs reconnect</span> : null}
              <span className="hint" style={{ fontSize: 12 }}>Fingerprint {c.secretFingerprint || '—'}</span>
              {!rotateOpen ? (
                <button className="btn ghost" onClick={() => setRotateOpen(true)} disabled={busy !== ''}>
                  {c.health === 'needs-reconnect' ? 'Reconnect · rotate credential' : 'Rotate credential'}
                </button>
              ) : null}
            </div>
            {rotateOpen ? (
              <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                <input
                  type="password"
                  value={rotateDraft}
                  onChange={(e) => setRotateDraft(e.target.value)}
                  placeholder="New credential (token / API key) — goes straight to Secrets Manager"
                  autoComplete="off"
                />
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" onClick={rotateCredential} disabled={busy !== '' || !rotateDraft.trim()}>Rotate</button>
                  <button className="btn ghost" onClick={() => { setRotateOpen(false); setRotateDraft(''); }} disabled={busy !== ''}>Cancel</button>
                </div>
                <span className="hint" style={{ fontSize: 11.5 }}>
                  The new value is written over the same vault ref — your grants + exposures are kept. Status resets to Untested; run Test connection to verify.
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Capability profile (editable) */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>Capability profile</span>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Tool</th><th>Mode</th><th>Limits</th><th></th></tr></thead>
              <tbody>
                {draft.map((t, i) => (
                  <tr key={t.name}>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>{t.name}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{t.description}</div>
                    </td>
                    <td>
                      {canManage ? (
                        <select value={t.mode} onChange={(e) => { const next = [...draft]; next[i] = { ...t, mode: e.target.value as CapabilityMode }; setDraft(next); }}>
                          {CAPABILITY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      ) : <span className={modeBadge(t.mode)}>{t.mode}</span>}
                    </td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {t.limits?.maxAmount !== undefined ? `≤ ${t.limits.maxAmount}` : ''}
                      {t.limits?.dataScope ? ` · ${t.limits.dataScope}` : ''}
                      {t.limits?.rateLimitPerMin ? ` · ${t.limits.rateLimitPerMin}/min` : ''}
                    </td>
                    <td>
                      <button className="btn ghost" style={{ padding: '3px 9px' }} onClick={() => tryTool(t.name)} disabled={busy !== ''}>Try</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canManage ? (
              <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={saveCaps} disabled={busy !== ''}>Save capability profile</button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Write-approval inline preview (appears after a Try that needs approval) */}
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
              <button className="btn ghost" onClick={denyApproval} disabled={busy !== ''}>Deny</button>
              <button className="btn ghost" onClick={approveOnce} disabled={busy !== ''}>Approve once</button>
              <button className="btn" onClick={approveRemember} disabled={busy !== ''}>Approve &amp; remember</button>
            </div>
            <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 11.5 }}>
              <strong>Approve &amp; remember</strong> creates a standing policy — identical calls auto-run without review.
            </p>
          </div>
        ) : null}

        {/* Attach to a specific agent (grant, restrict-only) */}
        {canManage ? (
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>Attach to an agent</span>
            <p className="hint" style={{ marginTop: 8, marginBottom: 10 }}>
              A grant can only narrow, never broaden — <strong>read-only</strong> exposes just the Read tools.
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" value={grantAgent} onChange={(e) => setGrantAgent(e.target.value)} placeholder="Agent principal (e.g. sales-assistant)" style={{ flex: '2 1 140px' }} />
              <select value={grantScope} onChange={(e) => setGrantScope(e.target.value as 'read-only' | 'full')} style={{ flex: '1 1 120px' }}>
                <option value="read-only">read-only</option>
                <option value="full">full (exposed tools)</option>
              </select>
              <button className="btn ghost" onClick={attachAgent} disabled={grantBusy || !grantAgent.trim()}>{grantBusy ? <span className="spin" /> : 'Attach'}</button>
            </div>
            {grantMsg ? <div className={grantMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 8 }}>{grantMsg}</div> : null}
          </div>
        ) : null}

        {/* Autonomous safety preset */}
        {canManage ? (
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>Autonomous agent safety preset</span>
            <p className="hint" style={{ marginTop: 8, marginBottom: 10 }}>
              <strong>read-only</strong>: reads only.{' '}
              <strong>read-propose</strong>: reads freely, proposes writes for review.{' '}
              <strong>read-bounded</strong>: reads + writes within capability limits.{' '}
              <strong>full-in-scope</strong>: all enabled tools.
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" value={agentPrincipal} onChange={(e) => setAgentPrincipal(e.target.value)} placeholder="Agent principal (e.g. sales-assistant)" style={{ flex: '2 1 140px' }} />
              <select value={autonomousPreset} onChange={(e) => setAutonomousPreset(e.target.value as AutonomousPreset)} style={{ flex: '1 1 130px' }}>
                {AUTONOMOUS_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button className="btn ghost" onClick={setPreset} disabled={presetBusy || !agentPrincipal.trim()}>{presetBusy ? <span className="spin" /> : 'Set preset'}</button>
            </div>
            {autonomousMsg ? <div className={autonomousMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 8 }}>{autonomousMsg}</div> : null}
            {draft.length > 0 ? (
              <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>Run autonomously as <span className="mono">{agentPrincipal || 'agent'}</span>:</span>
                {draft.slice(0, 3).map((t) => (
                  <button key={t.name} className="btn ghost" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => tryTool(t.name, { asAgent: agentPrincipal, autonomous: true })} disabled={busy !== ''}>{t.name}</button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
}

/** The connection's real health as a loud badge — healthy / needs reconnect / untested. */
function HealthBadge({ health }: { health: Conn['health'] }) {
  if (health === 'healthy') return <span className="badge ok">healthy</span>;
  if (health === 'needs-reconnect') return <span className="badge err">needs reconnect</span>;
  return <span className="badge muted">untested</span>;
}

// ---- Warehouse lifecycle controls (moved verbatim; unchanged behaviour) -----

type RegisterResult = { ok?: boolean; catalog?: string; detail?: string; error?: string };
type TestResult = { ok?: boolean; detail?: string; error?: string };

/**
 * Warehouse lifecycle — Register the Trino catalog (one click), Test it (SHOW SCHEMAS),
 * then Browse its schemas/tables. No YAML. A rolling Trino restart is slow, so after
 * Register we poll Test. Behaviour is unchanged from the previous inline card.
 */
function WarehouseControls({ c, canManage, onChange }: { c: Conn; canManage: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState('');
  const [regMsg, setRegMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [registered, setRegistered] = useState(c.health === 'healthy');
  const [browsing, setBrowsing] = useState(false);
  const pollRef = useRef(false);

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
        await pollTest();
      } else {
        setRegMsg(`✗ ${d.error ?? d.detail ?? 'Could not register the catalog'}`);
      }
    } catch (e) { setRegMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(''); }
  }

  async function pollTest() {
    pollRef.current = true;
    for (let i = 0; i < 9 && pollRef.current; i++) {
      await new Promise((res) => setTimeout(res, 10_000));
      try {
        const r = await postJSON(`/api/connections/${c.id}/test`);
        const d = r.data as TestResult;
        if (d.ok) { setTestMsg(`✓ ${d.detail ?? 'Catalog is queryable.'}`); onChange(); return; }
      } catch { /* keep polling */ }
    }
    if (pollRef.current) setTestMsg('Still waiting on Trino — click Test again in a moment.');
  }

  // Stop polling if the panel unmounts (e.g. leaving Edit) — no state updates after unmount.
  useEffect(() => () => { pollRef.current = false; }, []);

  async function test() {
    setBusy('test'); setTestMsg('');
    try {
      const r = await postJSON(`/api/connections/${c.id}/test`);
      const d = r.data as TestResult;
      setTestMsg(d.ok ? `✓ ${d.detail}` : `✗ ${d.error ?? d.detail ?? 'Register the catalog first, then test.'}`);
      if (d.ok) { setRegistered(true); onChange(); }
    } catch (e) { setTestMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(''); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {registered ? <span className="badge ok">catalog registered</span> : <span className="badge muted">needs register</span>}
        {canManage ? (
          <button className="btn ghost" onClick={register} disabled={busy !== ''}>{busy === 'register' ? <span className="spin" /> : registered ? 'Re-register' : 'Register catalog'}</button>
        ) : null}
        <button className="btn ghost" onClick={test} disabled={busy !== ''}>{busy === 'test' ? <span className="spin" /> : 'Test'}</button>
        <button className="btn ghost" onClick={() => setBrowsing((v) => !v)} disabled={busy !== ''}>{browsing ? 'Hide browse' : 'Browse'}</button>
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 11.5 }}>
        <strong>Register</strong> mounts this source as a Trino catalog, <strong>Test</strong> runs{' '}
        <span className="mono">SHOW SCHEMAS</span>, <strong>Browse</strong> lists schemas &amp; tables.
        Import a table from the Data tab&rsquo;s <em>Import from warehouse</em>.
      </p>
      {regMsg ? <div className={regMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{regMsg}</div> : null}
      {testMsg ? <div className={testMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{testMsg}</div> : null}
      {browsing ? <WarehouseBrowser connId={c.id} onSelect={() => { /* browse-only preview; import lives in the Data tab */ }} /> : null}
    </div>
  );
}
