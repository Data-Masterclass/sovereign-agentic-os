/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 * I18N:       converted (wave 2) — texts from `connections.builder.*` (plus `governed.health.*`, `governed.vis.*`,
 *             `governed.auth*`, `governed.bronzeSource*`/`filesIndex*`, `wizard.endpointLooksWrong`, `signInApps.pageName`).
 *             Error/detail text from the API, capability modes, preset/scope ids and tool names are shown as they are.
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
import { CAPABILITY_MODES, type CapabilityMode, type ConnectionTemplateKey } from '@tabs/connections/lib/schema';
import { isOperationalTemplate, operationalPlatformFor, templateHasActionTools } from '@tabs/connections/lib/operational-platform';
import { type Role, roleAtLeast } from '@core/kernel/session';
import { canManageArtifact } from '@core/policy/edit-scope';
import { providerForTemplate, providerConfig, type OAuthProvider } from '@core/auth/providers';
import { driveConnectionStatus, driveAuthorizePath } from '@core/auth/drive-status';
import LifecycleActions from '@core/ui/lifecycle/LifecycleActions';
import PromoteButton from '@core/ui/lifecycle/PromoteButton';
import DomainTag from '@core/ui/DomainTag';
import { useTranslations, useServerMessage } from '@core/i18n/client';
import { WarehouseBrowser } from '@tabs/data/ui/WarehouseImportPanel';
import ConnectorWizard, { type WizardStart, type WizardData } from '@tabs/connections/ui/ConnectorWizard';
import ConnectorGallery from '@tabs/connections/ui/ConnectorGallery';
import ExposePanel from '@tabs/connections/ui/ExposePanel';
import { testMessage } from '@tabs/connections/lib/test-result';
import { connectorIdentity, markStyle } from '@tabs/connections/lib/connector-identity';
import type { CSSProperties, ReactNode } from 'react';
import {
  type Conn, type Tool, type Data, type EgressRequest, type ApprovalPreview, type OAuthProviderStatus,
  badge, modeBadge, visWordKey, connVisibility, ladderTier, postJSON, looksLikeEndpoint, ENDPOINT_LOOKS_WRONG_KEY,
} from '@tabs/connections/ui/shared';

const AUTONOMOUS_PRESETS = ['read-only', 'read-propose', 'read-bounded', 'full-in-scope'] as const;
type AutonomousPreset = typeof AUTONOMOUS_PRESETS[number];
/** Grant scope ids — sent to the API and shown verbatim (the hint names `read-only` by id). */
const GRANT_SCOPE_READ_ONLY = 'read-only' as const;

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
  const t = useTranslations('connections');
  const canOpen = data.canCreate || data.canCreatePersonal;
  // For a NEW connection, which door the builder is on (null = the chooser itself).
  const [door, setDoor] = useState<NewDoor>(null);

  // ── NEW connection: the two-door type chooser ──
  if (!existing) {
    return (
      <div>
        <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
          <button className="btn ghost sm" onClick={door ? () => setDoor(null) : onBack}>
            {door ? t('builder.backChooser') : t('builder.backAll')}
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
            <div className="section-title" style={{ marginTop: 4 }}>{t('builder.bringConnector')}</div>
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
  const t = useTranslations('connections');
  if (!canOpen) {
    return (
      <div className="stub-page">
        {t('builder.noPermission')}
      </div>
    );
  }
  return (
    <div>
      <h2 style={{ margin: '0 0 6px' }}>{t('builder.chooserTitle')}</h2>
      <div className="conn-doors">
        <button
          type="button"
          className="conn-door conn-door--gold"
          onClick={() => onPick({ door: 'connector' })}
        >
          <span className="conn-door-mark" aria-hidden="true">◇</span>
          <div className="conn-door-eyebrow">{t('builder.doors.connectorEyebrow')}</div>
          <h3 className="conn-door-title">{t('builder.bringConnector')}</h3>
          <p className="conn-door-sub">
            {t('builder.doors.connectorSub')}
          </p>
          <span className="conn-door-cta">{t('builder.doors.connectorCta')} <span className="arr" aria-hidden="true">→</span></span>
        </button>

        <button
          type="button"
          className="conn-door conn-door--teal"
          onClick={() => onPick({ door: 'custom' })}
        >
          <span className="conn-door-mark" aria-hidden="true">◆</span>
          <div className="conn-door-eyebrow">{t('builder.doors.customEyebrow')}</div>
          <h3 className="conn-door-title">{t('builder.doors.customTitle')}</h3>
          <p className="conn-door-sub">
            {t('builder.doors.customSub')}
          </p>
          <span className="conn-door-cta">{t('builder.doors.customCta')} <span className="arr" aria-hidden="true">→</span></span>
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
  const t = useTranslations('connections');
  const serverMsg = useServerMessage();
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
      else setEgressErr(serverMsg(body, t('builder.custom.egressLoadFailed')));
    } catch (e) { setEgressErr((e as Error).message); }
  }, [t]);
  useEffect(() => { loadEgress(); }, [loadEgress]);

  const endpointHint = kind === 'api' ? 'https://api.example.com' : 'https://mcp.example.com/sse';

  /** The egress request status word; an unknown status from the API is shown as is. */
  function egressStatusLabel(status: string): string {
    if (status === 'pending' || status === 'approved' || status === 'rejected') return t(`builder.custom.egressStatus.${status}`);
    return status;
  }

  async function handleAdd() {
    if (!name.trim() || !endpoint.trim() || busy) return;
    // Client-side URL-shape guard: never ship an obviously-non-URL (a pasted credential)
    // to the egress path, where the error would echo it back. Server stays the authority.
    if (!looksLikeEndpoint(endpoint)) { setMsg(`✗ ${t(ENDPOINT_LOOKS_WRONG_KEY)}`); setMsgOk(false); return; }
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
        const err = serverMsg(connRes.data, t('builder.custom.createFailed'));
        setMsg(`✗ ${egressRes.ok ? t('builder.custom.failedRetry', { error: err }) : err}`);
        await loadEgress();
        return;
      }
      const connName = (connRes.data.connection as { name?: string })?.name ?? name.trim();
      setMsg(`✓ ${egressRes.ok ? t('builder.custom.createdEgress', { name: connName }) : t('builder.custom.created', { name: connName })}`);
      setMsgOk(true);
      setName(''); setEndpoint(''); setCredential('');
      onDone();
      await loadEgress();
    } catch (e) { setMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="section-title" style={{ marginTop: 4 }}>{t('builder.doors.customTitle')}</div>
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
              {k === 'api' ? t('builder.custom.kindApi') : t('builder.custom.kindMcp')}
            </button>
          ))}
        </div>

        {/* Fields */}
        <div style={{ display: 'grid', gap: 10 }}>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('builder.custom.namePlaceholder', { kind })} autoComplete="off" />
          <input type="text" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={t('builder.custom.baseUrlPlaceholder', { hint: endpointHint })} autoComplete="off" />
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder={t('builder.custom.credentialPlaceholder', { kind })}
            autoComplete="off"
          />
        </div>

        <p className="hint" style={{ marginTop: 10, marginBottom: 0, fontSize: 11.5 }}>
          {t('builder.custom.hint')}
        </p>

        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
          {msgOk ? <button className="btn ghost" onClick={onCreated}>{t('builder.custom.done')}</button> : null}
          <button className="btn" onClick={handleAdd} disabled={busy || !name.trim() || !endpoint.trim()}>
            {busy ? <span className="spin" /> : t('builder.custom.add', { kind })}
          </button>
        </div>

        {msg ? <div className={msgOk ? 'answer' : 'error'} style={{ marginTop: 10 }}>{msg}</div> : null}
      </div>

      {/* Egress request status — pending/approved/rejected for this domain */}
      {egressErr ? <div className="error" style={{ marginTop: 8 }}>{egressErr}</div> : null}
      {egressRequests.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>{t('builder.custom.colHost')}</th><th>{t('builder.custom.colReason')}</th><th>{t('builder.custom.colStatus')}</th></tr></thead>
            <tbody>
              {egressRequests.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.host}</td>
                  <td className="muted">{r.reason}</td>
                  <td><span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'err' : 'muted'}`}>{egressStatusLabel(r.status)}</span></td>
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
  const t = useTranslations('connections');
  const serverMsg = useServerMessage();
  const tc = useTranslations('common');
  const role = user.role;
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [confirmDemote, setConfirmDemote] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(c.name);
  const [draft, setDraft] = useState<Tool[]>(c.tools);
  const [approvalState, setApprovalState] = useState<{ tool: string; preview: ApprovalPreview } | null>(null);
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
  const exposed = c.tools.filter((tl) => tl.mode === 'Read' || tl.mode === 'Write-approval' || tl.mode === 'Write-bounded');
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
      const detail = (r.data.detail as string) ?? serverMsg(r.data, t('builder.msg.verifyFailed'));
      setNotionMsg(`${r.data.ok ? '✓' : '✗'} ${detail}`);
      setNotionTools((r.data.tools as { name: string; description?: string }[]) ?? []);
      if (r.data.ok) onChanged();
    } catch (e) { setNotionMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(''); }
  }

  async function disconnect(kind: 'drive' | 'notion') {
    if (typeof window !== 'undefined' && !window.confirm(t('builder.msg.disconnectConfirm', { name: c.name }))) return;
    setBusy('disconnect');
    (kind === 'notion' ? setNotionMsg : setMsg)('');
    try {
      const res = await fetch(`/api/connections/${c.id}`, { method: 'DELETE' });
      if (res.ok) { onChanged(); onBack(); return; }
      const d = await res.json() as { error?: string };
      (kind === 'notion' ? setNotionMsg : setMsg)(`✗ ${serverMsg(d, t('builder.msg.disconnectFailed'))}`);
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
    setMsg(testMessage(r.data));
    if (r.data.ok) onChanged();
  }

  async function demote() {
    const r = await doPost(`/api/connections/${c.id}/demote`);
    const conn = r.data.connection as Conn | undefined;
    setMsg(r.ok ? `✓ ${t('builder.msg.revoked', { scope: conn ? t(visWordKey(conn.visibility)) : '' })}` : `✗ ${serverMsg(r.data)}`);
    if (r.ok) onChanged();
  }

  async function submitRename() {
    const name = renameDraft.trim();
    if (!name || name === c.name) { setRenaming(false); return; }
    const r = await doPost(`/api/connections/${c.id}`, { action: 'rename', name });
    if (r.ok) { setRenaming(false); onChanged(); }
    else setMsg(`✗ ${serverMsg(r.data, t('builder.msg.renameFailed'))}`);
  }

  async function saveCaps() {
    const updates = draft.map((tl) => ({ name: tl.name, mode: tl.mode, limits: tl.limits }));
    const r = await doPost(`/api/connections/${c.id}/capabilities`, { updates });
    setMsg(r.ok ? `✓ ${t('builder.msg.capsSaved')}` : `✗ ${serverMsg(r.data)}`);
    if (r.ok) { onChanged(); setMode('view'); }
  }

  async function setUsage() {
    const usage = isDrive ? 'files' : 'bronze';
    const r = await doPost(`/api/connections/${c.id}/usage`, { usage });
    if (r.ok) { const updated = r.data.connection as Conn | undefined; setDataUsage(updated?.dataUsage ?? usage); onChanged(); }
    else setMsg(`✗ ${serverMsg(r.data)}`);
  }

  async function rotateCredential() {
    const credential = rotateDraft;
    if (!credential.trim()) { setMsg(`✗ ${t('builder.msg.pasteCredential')}`); return; }
    const r = await doPost(`/api/connections/${c.id}`, { action: 'rotate-credential', credential });
    if (r.ok) {
      setRotateOpen(false); setRotateDraft('');
      setMsg(`✓ ${t('builder.msg.rotated')}`);
      onChanged();
    } else setMsg(`✗ ${serverMsg(r.data, t('builder.msg.rotateFailed'))}`);
  }

  async function tryTool(toolName: string, opts?: { asAgent?: string; autonomous?: boolean }) {
    const tool = draft.find((x) => x.name === toolName);
    const args: Record<string, unknown> = tool?.mode === 'Write-bounded'
      ? { id: 'OPP-1', amount: tool.limits?.maxAmount ?? 1000 }
      : { id: 'acct-1' };
    const body: Record<string, unknown> = { tool: toolName, args };
    if (opts?.asAgent) { body.asAgent = opts.asAgent; body.autonomous = opts.autonomous ?? false; }
    const r = await doPost(`/api/connections/${c.id}/tool`, body);
    const d = r.data;
    if (d.decision === 'requires_approval' && d.preview) {
      // The viewer made this call, so the viewer is its REQUESTER: four eyes — another approver
      // decides it in the Governance inbox. This card only shows what was held.
      setApprovalState({ tool: toolName, preview: d.preview as ApprovalPreview });
    } else {
      setApprovalState(null);
      const icon = d.decision === 'allow' ? '✓' : d.decision === 'block' ? '✗' : '⏸';
      // HONESTY (C2): if the executor returned an offline-mock envelope, say so in the
      // result line — never let a demonstration fixture read as a live call.
      const mock = (d.result as { mode?: string } | undefined)?.mode === 'offline-mock';
      setMsg(`${icon} ${t('builder.msg.tryResult', {
        tool: toolName,
        decision: d.decision as string,
        reason: (d.reason ?? d.error) as string,
        queued: d.queuedForReview ? 'yes' : 'no',
        mock: mock ? 'yes' : 'no',
      })}`);
      if (d.decision === 'requires_approval') onChanged();
    }
  }

  function dismissHeld() {
    if (!approvalState) return;
    const { tool } = approvalState;
    setApprovalState(null);
    setMsg(`⏸ ${t('builder.msg.held', { tool })}`);
  }

  async function attachAgent() {
    if (!grantAgent.trim() || grantBusy) return;
    setGrantBusy(true); setGrantMsg('');
    const r = await postJSON(`/api/connections/${c.id}/grant`, { agent: grantAgent.trim(), scope: grantScope });
    setGrantMsg(r.ok
      ? `✓ ${t('builder.msg.attached', { agent: grantAgent.trim(), scope: grantScope })}`
      : `✗ ${serverMsg(r.data)}`);
    setGrantBusy(false);
    if (r.ok) onChanged();
  }

  async function setPreset() {
    if (!agentPrincipal.trim() || presetBusy) return;
    setPresetBusy(true); setAutonomousMsg('');
    const r = await postJSON(`/api/connections/${c.id}/autonomous`, { agent: agentPrincipal.trim(), preset: autonomousPreset });
    setAutonomousMsg(r.ok ? `✓ ${t('builder.msg.presetApplied', { preset: autonomousPreset, agent: agentPrincipal.trim() })}` : `✗ ${serverMsg(r.data)}`);
    setPresetBusy(false);
  }

  const canRevoke = (c.visibility === 'Certified' && role === 'admin') || (c.visibility === 'Shared' && canManage);
  const identity = connectorIdentity(c.template, { label: c.name });
  const strong = (chunks: ReactNode) => <strong>{chunks}</strong>;
  const mono = (chunks: ReactNode) => <span className="mono">{chunks}</span>;

  /** A tool's limits as one calm line (≤ amount · data scope · rate/min). */
  function limitsLine(tl: Tool): string {
    return (tl.limits?.maxAmount !== undefined ? `≤ ${tl.limits.maxAmount}` : '')
      + (tl.limits?.dataScope ? ` · ${tl.limits.dataScope}` : '')
      + (tl.limits?.rateLimitPerMin ? ` · ${t('builder.view.perMin', { rate: tl.limits.rateLimitPerMin })}` : '');
  }

  /** The OAuth (Drive / Notion) connect status badge. */
  function connectStatusBadge(status: ReturnType<typeof driveConnectionStatus>) {
    return status === 'connected' ? <span className="badge ok">{t('builder.status.connectedAs', { owner: c.owner })}</span>
      : status === 'needs-reconnect' ? <span className="badge err">{t('builder.status.needsReconnect')}</span>
      : <span className="badge muted">{t('builder.status.notConnected')}</span>;
  }

  return (
    <div>
      {/* ── Header: back · Rename · badges · View⇄Edit · Promote · Unshare · lifecycle ── */}
      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onBack}>{t('builder.backAll')}</button>
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
              aria-label={t('builder.header.nameAria')}
            />
            <button className="btn primary sm" onClick={() => void submitRename()} disabled={busy !== ''}>{t('builder.header.save')}</button>
            <button className="btn ghost sm" onClick={() => { setRenaming(false); setRenameDraft(c.name); }}>{tc('actions.cancel')}</button>
          </span>
        ) : (
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            {c.name}
            {canManage ? (
              <button
                className="btn ghost sm"
                style={{ flex: 'none' }}
                onClick={() => { setRenameDraft(c.name); setRenaming(true); }}
                title={t('builder.header.renameTitle')}
                aria-label={t('builder.header.renameAria')}
              >{t('builder.header.rename')}</button>
            ) : null}
          </h2>
        )}
        <span className="badge muted">{c.type}</span>
        <HealthBadge health={c.health} />
        {dataUsage === 'bronze' ? <span className="badge warn">{c.dataUsageMode === 'offline-mock' ? t('governed.bronzeSourceMock') : t('governed.bronzeSource')}</span> : null}
        {dataUsage === 'files' ? <span className="badge warn">{c.dataUsageMode === 'offline-mock' ? t('governed.filesIndexMock') : t('governed.filesIndex')}</span> : null}
        {c.archived ? <span className="badge muted">{t('governed.archived')}</span> : null}
        {(c.visibility === 'Shared' || c.visibility === 'Certified') ? <DomainTag domain={c.domain} /> : null}
        <span className={badge(c.visibility)}>{t(visWordKey(c.visibility))}</span>

        {canManage ? (
          <div className="row" style={{ marginLeft: 'auto', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {mode === 'view'
              ? <button className="btn ghost sm" onClick={() => setMode('edit')} title={t('builder.header.editTitle')}>{t('builder.header.edit')}</button>
              : <button className="btn ghost sm" onClick={() => setMode('view')} title={t('builder.header.viewTitle')}>{t('builder.header.view')}</button>}
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
                    {c.visibility === 'Certified' ? t('builder.header.confirmRevoke') : t('builder.header.confirmUnshare')}
                  </button>
                  <button className="btn ghost sm" onClick={() => setConfirmDemote(false)} disabled={busy !== ''}>{tc('actions.cancel')}</button>
                </>
              ) : (
                <button className="btn ghost sm" onClick={() => setConfirmDemote(true)} disabled={busy !== ''}>
                  {c.visibility === 'Certified' ? t('builder.header.revokeFromCompany') : t('builder.header.unshare')}
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
          <span className="comp-label" style={{ margin: 0 }}>{t('builder.view.status')}</span>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
            <HealthBadge health={c.health} />
            {/* Drive / Notion connect status folds into the status line honestly. */}
            {driveProvider ? connectStatusBadge(driveStatus) : null}
            {isNotion ? connectStatusBadge(notionStatus) : null}
            {/* Test connection is a READ-side health act — reachable in View. Warehouse
                keeps its own Register→Test lifecycle in Edit; here we surface reachability. */}
            {!isWarehouse ? (
              <button className="btn ghost sm" onClick={test} disabled={busy !== ''}>
                {busy === `/api/connections/${c.id}/test` ? <span className="spin" /> : c.health === 'needs-reconnect' ? t('builder.view.testReconnect') : t('builder.view.testConnection')}
              </button>
            ) : (
              <button className="btn ghost sm" onClick={test} disabled={busy !== ''}>
                {busy === `/api/connections/${c.id}/test` ? <span className="spin" /> : t('builder.view.testConnection')}
              </button>
            )}
          </div>
        </div>

        {/* What it connects to */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>{t('builder.view.connectsTo')}</span>
          <div className="muted mono" style={{ marginTop: 10, fontSize: 11.5 }}>
            {c.connector} · {c.auth === 'oauth' ? t('governed.authOauth') : t('governed.authService')} · {c.owner}/{c.domain}
            {c.endpoint ? <> · {c.endpoint}</> : null}
          </div>
          <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
            {t('builder.view.secret')} <span className="mono">{c.secretRef.name}/{c.secretRef.key}</span>{' '}
            {c.secretSet ? <span className="badge ok">{t('builder.view.secretStored')}</span> : <span className="badge muted">{t('builder.view.secretNone')}</span>}{' '}
            {c.secretFingerprint ? <span className="mono" style={{ fontSize: 11 }}>{c.secretFingerprint}</span> : null}
            <span style={{ marginLeft: 10 }}>
              {t('builder.view.egress')}{' '}
              {c.egress.external
                ? <span className={`badge ${c.egress.allowed ? 'ok' : 'err'}`}>{c.egress.allowed ? t('builder.view.egressAllowed', { host: c.egress.host }) : t('builder.view.egressBlocked', { host: c.egress.host })}</span>
                : <span className="badge muted">{t('builder.view.egressInternal')}</span>}
            </span>
          </div>
          {c.warehouse ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              {t.rich('builder.view.federated', { catalog: c.warehouse.catalog, platform: c.warehouse.platform, mono, strong })}
            </p>
          ) : null}
          {c.visibility === 'Certified' ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
              {t('builder.view.marketplace')}
            </p>
          ) : null}
        </div>

        {/* Capabilities / tools it exposes (read-only) */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>{t('builder.view.capabilities')}</span>
          {c.tools.length === 0 ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{t('builder.view.noTools')}</p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>{t('builder.view.colTool')}</th><th>{t('builder.view.colMode')}</th><th>{t('builder.view.colLimits')}</th></tr></thead>
                <tbody>
                  {c.tools.map((tl) => (
                    <tr key={tl.name}>
                      <td>
                        <div className="mono" style={{ fontWeight: 600 }}>{tl.name}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{tl.description}</div>
                      </td>
                      <td><span className={modeBadge(tl.mode)}>{tl.mode}</span></td>
                      <td className="muted" style={{ fontSize: 11.5 }}>
                        {limitsLine(tl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
            {t('builder.view.exposedTools')} <span className="mono">{exposed.map((tl) => tl.name).join(', ') || t('builder.view.none')}</span>
            {c.grants.length ? <span style={{ marginLeft: 10 }}>{t('builder.view.attachedTo', { list: c.grants.map((g) => `${g.agent} (${g.scope})`).join(', ') })}</span> : null}
          </p>
        </div>

        {/* Usage notes */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>{t('builder.view.usage')}</span>
          <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            {dataUsage === 'files'
              ? t('builder.view.usageFiles')
              : dataUsage === 'bronze'
                ? t('builder.view.usageBronze')
                : isDrive
                  ? t('builder.view.usageCanFiles')
                  : t('builder.view.usageCanBronze')}
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
            <span className="comp-label" style={{ margin: 0 }}>{t('builder.edit.connectDriveTitle', { label: driveProviderLabel })}</span>
            <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {connectStatusBadge(driveStatus)}
              {!driveProviderConfigured ? (
                <span className="hint" style={{ fontSize: 12 }}>{t('builder.edit.driveNotConfigured', { label: driveProviderLabel, page: t('signInApps.pageName') })}</span>
              ) : driveStatus === 'connected' ? (
                <>
                  <button className="btn ghost" onClick={connectDrive} disabled={busy !== ''}>{t('builder.edit.reconnect')}</button>
                  <button className="btn ghost" onClick={() => disconnect('drive')} disabled={busy !== ''}>{t('builder.edit.disconnect')}</button>
                </>
              ) : driveStatus === 'needs-reconnect' ? (
                <>
                  <button className="btn" onClick={connectDrive} disabled={busy !== ''}>{t('builder.edit.reconnect')}</button>
                  <button className="btn ghost" onClick={() => disconnect('drive')} disabled={busy !== ''}>{t('builder.edit.disconnect')}</button>
                </>
              ) : (
                <button className="btn" onClick={connectDrive} disabled={busy !== ''}>{t('builder.edit.connectDrive', { label: driveProviderLabel })}</button>
              )}
            </div>
          </div>
        ) : null}

        {/* Notion hosted-MCP connect controls (own workspace, own consent). */}
        {isNotion ? (
          <div className="guided-panel" style={{ marginTop: 4 }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('builder.edit.connectNotionTitle')}</span>
            <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {connectStatusBadge(notionStatus)}
              {notionStatus === 'connected' ? (
                <>
                  <button className="btn ghost" onClick={verifyNotion} disabled={busy !== ''}>{busy === 'verify-notion' ? <span className="spin" /> : t('builder.edit.verifyNotion')}</button>
                  <button className="btn ghost" onClick={connectNotion} disabled={busy !== ''}>{t('builder.edit.reconnect')}</button>
                  <button className="btn ghost" onClick={() => disconnect('notion')} disabled={busy !== ''}>{t('builder.edit.disconnect')}</button>
                </>
              ) : notionStatus === 'needs-reconnect' ? (
                <>
                  <button className="btn" onClick={connectNotion} disabled={busy !== ''}>{t('builder.edit.reconnect')}</button>
                  <button className="btn ghost" onClick={() => disconnect('notion')} disabled={busy !== ''}>{t('builder.edit.disconnect')}</button>
                </>
              ) : (
                <button className="btn" onClick={connectNotion} disabled={busy !== ''}>{t('builder.edit.connectNotion')}</button>
              )}
            </div>
            {notionMsg ? <div className={notionMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{notionMsg}</div> : null}
            {notionTools && notionTools.length > 0 ? (
              <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>{t('builder.edit.liveTools', { list: notionTools.map((tl) => tl.name).join(', ') })}</div>
            ) : null}
          </div>
        ) : null}

        {/* Warehouse lifecycle — Register → Test → Browse (its own block; no YAML). */}
        {isWarehouse ? (
          <div className="guided-panel" style={{ marginTop: 4 }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('builder.edit.warehouseCatalog')}</span>
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
          <span className="comp-label" style={{ margin: 0 }}>{t('builder.edit.dataSource')}</span>
          <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {!dataUsage ? (
              <button className="btn ghost" onClick={setUsage} disabled={busy !== ''}>{isDrive ? t('builder.edit.indexFiles') : t('builder.edit.ingestBronze')}</button>
            ) : (
              <span className="hint" style={{ fontSize: 12 }}>{t('builder.edit.sameConnection', { usage: dataUsage })}</span>
            )}
          </div>
          {dataUsage && c.dataUsageMode === 'offline-mock' ? (
            <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 11.5 }}>
              {t.rich('builder.edit.offlineMock', { strong })}
            </p>
          ) : null}
        </div>

        {/* Credential rotation (M13) — re-supply an expired/rotated service credential
            over the SAME vault ref, keeping grants + exposures. */}
        {canRotate ? (
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('builder.edit.credential')}</span>
            <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {c.health === 'needs-reconnect' ? <span className="badge err">{t('builder.status.needsReconnect')}</span> : null}
              {c.health === 'needs-reconnect' ? <span className="hint" style={{ fontSize: 12 }}>{t('builder.edit.credentialUnusable')}</span> : null}
              <span className="hint" style={{ fontSize: 12 }}>{t('builder.edit.fingerprint', { fingerprint: c.secretFingerprint || '—' })}</span>
              {!rotateOpen ? (
                <button className="btn ghost" onClick={() => setRotateOpen(true)} disabled={busy !== ''}>
                  {c.health === 'needs-reconnect' ? t('builder.edit.reconnectRotate') : t('builder.edit.rotateCredential')}
                </button>
              ) : null}
            </div>
            {rotateOpen ? (
              <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                <input
                  type="password"
                  value={rotateDraft}
                  onChange={(e) => setRotateDraft(e.target.value)}
                  placeholder={t('builder.edit.rotatePlaceholder')}
                  autoComplete="off"
                />
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" onClick={rotateCredential} disabled={busy !== '' || !rotateDraft.trim()}>{t('builder.edit.rotate')}</button>
                  <button className="btn ghost" onClick={() => { setRotateOpen(false); setRotateDraft(''); }} disabled={busy !== ''}>{tc('actions.cancel')}</button>
                </div>
                <span className="hint" style={{ fontSize: 11.5 }}>
                  {t('builder.edit.rotateHint')}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Capability profile (editable) */}
        <div className="guided-panel" style={{ marginTop: 14 }}>
          <span className="comp-label" style={{ margin: 0 }}>{t('builder.edit.capabilityProfile')}</span>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>{t('builder.view.colTool')}</th><th>{t('builder.view.colMode')}</th><th>{t('builder.view.colLimits')}</th><th></th></tr></thead>
              <tbody>
                {draft.map((tl, i) => (
                  <tr key={tl.name}>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>{tl.name}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{tl.description}</div>
                    </td>
                    <td>
                      {canManage ? (
                        <select value={tl.mode} onChange={(e) => { const next = [...draft]; next[i] = { ...tl, mode: e.target.value as CapabilityMode }; setDraft(next); }}>
                          {CAPABILITY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      ) : <span className={modeBadge(tl.mode)}>{tl.mode}</span>}
                    </td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {limitsLine(tl)}
                    </td>
                    <td>
                      <button className="btn ghost" style={{ padding: '3px 9px' }} onClick={() => tryTool(tl.name)} disabled={busy !== ''}>{t('builder.edit.try')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canManage ? (
              <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={saveCaps} disabled={busy !== ''}>{t('builder.edit.saveCaps')}</button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Write-approval inline preview (appears after a Try that needs approval) */}
        {approvalState ? (
          <div className="card" style={{ marginTop: 12, background: 'var(--panel)', borderColor: 'var(--gold-line)' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{t('builder.approval.title')}</span>
              <span className="badge warn">{t('builder.approval.held')}</span>
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
              {t.rich('builder.approval.meta', {
                action: approvalState.preview.action,
                who: approvalState.preview.who,
                reason: approvalState.preview.reason,
                strong,
                mono,
              })}
            </div>
            {approvalState.preview.diff.length > 0 ? (
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr><th>{t('builder.approval.colField')}</th><th>{t('builder.approval.colBefore')}</th><th>{t('builder.approval.colAfter')}</th></tr></thead>
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
            {/* FOUR EYES: the card is always the viewer's OWN held call, and a requester never
                approves their own write — it waits in the Governance inbox for another approver. */}
            <p className="hint" style={{ marginTop: 10, marginBottom: 0, fontSize: 12 }}>
              {t.rich('builder.approval.fourEyes', { link: (chunks) => <a href="/governance">{chunks}</a> })}
            </p>
            <div className="row" style={{ marginTop: 8, gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={dismissHeld} disabled={busy !== ''}>{tc('actions.dismiss')}</button>
            </div>
          </div>
        ) : null}

        {/* Attach to a specific agent (grant, restrict-only) */}
        {canManage ? (
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('builder.grant.title')}</span>
            <p className="hint" style={{ marginTop: 8, marginBottom: 10 }}>
              {t.rich('builder.grant.hint', { strong })}
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" value={grantAgent} onChange={(e) => setGrantAgent(e.target.value)} placeholder={t('builder.grant.agentPlaceholder')} style={{ flex: '2 1 140px' }} />
              <select value={grantScope} onChange={(e) => setGrantScope(e.target.value as 'read-only' | 'full')} style={{ flex: '1 1 120px' }}>
                <option value={GRANT_SCOPE_READ_ONLY}>{GRANT_SCOPE_READ_ONLY}</option>
                <option value="full">{t('builder.grant.scopeFull')}</option>
              </select>
              <button className="btn ghost" onClick={attachAgent} disabled={grantBusy || !grantAgent.trim()}>{grantBusy ? <span className="spin" /> : t('builder.grant.attach')}</button>
            </div>
            {grantMsg ? <div className={grantMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 8 }}>{grantMsg}</div> : null}
          </div>
        ) : null}

        {/* Autonomous safety preset */}
        {canManage ? (
          <div className="guided-panel" style={{ marginTop: 14 }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('builder.preset.title')}</span>
            <p className="hint" style={{ marginTop: 8, marginBottom: 10 }}>
              {t.rich('builder.preset.descriptions', { strong })}
            </p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <input type="text" value={agentPrincipal} onChange={(e) => setAgentPrincipal(e.target.value)} placeholder={t('builder.grant.agentPlaceholder')} style={{ flex: '2 1 140px' }} />
              <select value={autonomousPreset} onChange={(e) => setAutonomousPreset(e.target.value as AutonomousPreset)} style={{ flex: '1 1 130px' }}>
                {AUTONOMOUS_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button className="btn ghost" onClick={setPreset} disabled={presetBusy || !agentPrincipal.trim()}>{presetBusy ? <span className="spin" /> : t('builder.preset.set')}</button>
            </div>
            {autonomousMsg ? <div className={autonomousMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 8 }}>{autonomousMsg}</div> : null}
            {draft.length > 0 ? (
              <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>{t.rich('builder.preset.runAs', { agent: agentPrincipal || t('builder.preset.agentFallback'), mono })}</span>
                {draft.slice(0, 3).map((tl) => (
                  <button key={tl.name} className="btn ghost" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => tryTool(tl.name, { asAgent: agentPrincipal, autonomous: true })} disabled={busy !== ''}>{tl.name}</button>
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
  const t = useTranslations('connections');
  if (health === 'healthy') return <span className="badge ok">{t('governed.health.healthy')}</span>;
  if (health === 'needs-reconnect') return <span className="badge err">{t('governed.health.needsReconnect')}</span>;
  return <span className="badge muted">{t('governed.health.untested')}</span>;
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
  const t = useTranslations('connections');
  const serverMsg = useServerMessage();
  const [busy, setBusy] = useState('');
  const [regMsg, setRegMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
  const [registered, setRegistered] = useState(c.health === 'healthy');
  const [browsing, setBrowsing] = useState(false);
  const pollRef = useRef(false);

  async function register() {
    setBusy('register');
    setRegMsg(t('builder.wh.registering'));
    setTestMsg('');
    try {
      const r = await postJSON(`/api/connections/${c.id}/register`);
      const d = r.data as RegisterResult;
      if (r.ok && d.ok !== false) {
        setRegMsg(`✓ ${t('builder.wh.registeredMsg', { catalog: d.catalog ?? c.warehouse?.catalog ?? '', detail: d.detail ?? t('builder.wh.testing') })}`);
        setRegistered(true);
        onChange();
        await pollTest();
      } else {
        setRegMsg(`✗ ${serverMsg(d, d.detail ?? t('builder.wh.registerFailed'))}`);
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
        if (d.ok) { setTestMsg(`✓ ${d.detail ?? t('builder.wh.queryable')}`); onChange(); return; }
      } catch { /* keep polling */ }
    }
    if (pollRef.current) setTestMsg(t('builder.wh.stillWaiting'));
  }

  // Stop polling if the panel unmounts (e.g. leaving Edit) — no state updates after unmount.
  useEffect(() => () => { pollRef.current = false; }, []);

  async function test() {
    setBusy('test'); setTestMsg('');
    try {
      const r = await postJSON(`/api/connections/${c.id}/test`);
      const d = r.data as TestResult;
      setTestMsg(d.ok ? `✓ ${d.detail}` : `✗ ${serverMsg(d, d.detail ?? t('builder.wh.registerFirst'))}`);
      if (d.ok) { setRegistered(true); onChange(); }
    } catch (e) { setTestMsg(`✗ ${(e as Error).message}`); }
    finally { setBusy(''); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {registered ? <span className="badge ok">{t('builder.wh.registered')}</span> : <span className="badge muted">{t('builder.wh.needsRegister')}</span>}
        {canManage ? (
          <button className="btn ghost" onClick={register} disabled={busy !== ''}>{busy === 'register' ? <span className="spin" /> : registered ? t('builder.wh.reRegister') : t('builder.wh.register')}</button>
        ) : null}
        <button className="btn ghost" onClick={test} disabled={busy !== ''}>{busy === 'test' ? <span className="spin" /> : t('builder.wh.test')}</button>
        <button className="btn ghost" onClick={() => setBrowsing((v) => !v)} disabled={busy !== ''}>{browsing ? t('builder.wh.hideBrowse') : t('builder.wh.browse')}</button>
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 11.5 }}>
        {t.rich('builder.wh.help', {
          strong: (chunks) => <strong>{chunks}</strong>,
          mono: (chunks) => <span className="mono">{chunks}</span>,
          em: (chunks) => <em>{chunks}</em>,
        })}
      </p>
      {regMsg ? <div className={regMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{regMsg}</div> : null}
      {testMsg ? <div className={testMsg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 8 }}>{testMsg}</div> : null}
      {browsing ? <WarehouseBrowser connId={c.id} onSelect={() => { /* browse-only preview; import lives in the Data tab */ }} /> : null}
    </div>
  );
}
