/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import CodePanel from '@/components/CodePanel';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import { useToolWindow } from '@/components/ToolWindowProvider';
import { useApi } from '@/lib/useApi';
import { getUrlParam, patchUrl } from '@/lib/core/url-params';
import { roleAtLeast, type Role as SessionRole } from '@/lib/core/session';
import DomainTag from '@/components/DomainTag';

type Visibility = 'Personal' | 'Shared' | 'Certified';
type Tool = { name: string; description: string; write: boolean };
type AppFile = { name: string; description: string; visibility: Visibility };
type ChatMsg = { role: 'user' | 'assistant'; content: string; at: string };
type App = {
  id: string;
  slug: string;
  name: string;
  description: string;
  template: string;
  owner: string;
  domain: string;
  visibility: Visibility;
  mode: 'live' | 'offline';
  repo: { fullName: string; htmlUrl: string; seeded: string[] };
  subdomain: string;
  pipeline: Record<string, string>;
  chat: ChatMsg[];
  files: AppFile[];
  mcpPrincipal: string;
  mcpTools: Tool[];
  status: 'active' | 'archived';
  deploy: {
    state: 'building' | 'preview' | 'review' | 'live';
    previewUrl: string | null;
    reviewCardId: string | null;
    releases: number;
  };
  manifest: { connections: string[]; data: string[]; knowledge: string[]; hasOpenApi: boolean; missing: string[] };
  surface: { ui: boolean; api: boolean };
  consumes: { kind: string; ref: string; label: string; scope: string }[];
  usedAsData: boolean;
  dataArtifactId: string | null;
};
type Connection = { id: string; name: string; principal: string; visibility: Visibility; tools: Tool[] } | null;
type Data = { user: { id: string; role: SessionRole }; app: App; connection: Connection };

const STAGES = ['forgejo', 'actions', 'harbor', 'argocd', 'live'] as const;
const STAGE_LABEL: Record<string, string> = {
  forgejo: 'Forgejo',
  actions: 'CI',
  harbor: 'Harbor',
  argocd: 'Argo CD',
  live: 'Live',
};
function stageClass(s: string): string {
  if (s === 'ok') return 'badge ok';
  if (s === 'pending') return 'badge warn';
  if (s === 'disabled') return 'badge muted';
  return 'badge err';
}
function visBadge(v: Visibility): string {
  return `badge vis-${v.toLowerCase()}`;
}
function visDisplayLabel(v: Visibility): string {
  // Display vocabulary: Shared → "Domain", Certified → "Company" (My stays for Personal).
  if (v === 'Shared') return 'Domain';
  if (v === 'Certified') return 'Company';
  return v;
}
function deployBadge(state: App['deploy']['state']): { cls: string; label: string } {
  if (state === 'live') return { cls: 'badge ok', label: 'Live' };
  if (state === 'review') return { cls: 'badge warn', label: 'In review' };
  if (state === 'preview') return { cls: 'badge muted', label: 'Preview' };
  return { cls: 'badge muted', label: 'Draft' };
}
function promoteLabel(v: Visibility): string | null {
  // Display verbs: Personal → "Promote to Domain"; Shared → "Certify to Company".
  if (v === 'Personal') return 'Promote to Domain';
  if (v === 'Shared') return 'Certify to Company';
  return null;
}

export default function AppPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const { openTool } = useToolWindow();
  const id = params?.id;
  const { data, loading, error, reload } = useApi<Data>(`/api/apps/${id ?? ''}`);

  const [mode, setMode] = useState<'monitor' | 'edit'>(search?.get('mode') === 'edit' ? 'edit' : 'monitor');
  const [busy, setBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState('');
  const [showApi, setShowApi] = useState(false);
  const [manage, setManage] = useState(false);
  const [confirmDemote, setConfirmDemote] = useState(false);

  // Persist whether Edit mode is open in the URL so a reload restores the editor
  // instead of the default Monitor view.
  useEffect(() => {
    patchUrl({
      mode: mode === 'edit' ? 'edit' : null,
    });
  }, [mode]);
  useEffect(() => {
    const sync = () => {
      setMode(getUrlParam('mode') === 'edit' ? 'edit' : 'monitor');
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const [msg, setMsg] = useState('');
  const [toolOut, setToolOut] = useState('');
  const [connRef, setConnRef] = useState('');
  const [connLabel, setConnLabel] = useState('');
  const [connScope, setConnScope] = useState<'read' | 'write-bounded'>('read');

  async function deployAction(action?: 'preview') {
    if (!id || busy) return;
    setBusy(true);
    setDeployMsg('');
    try {
      const res = await fetch(`/api/apps/${id}/deploy${action ? `?action=${action}` : ''}`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setDeployMsg(`✗ ${body.error}`);
      else if (action === 'preview')
        setDeployMsg(
          body.app?.deploy?.previewUrl
            ? '✓ Preview running — open the app UI above.'
            : '✓ Preview requested — the in-cluster runner is provisioning; the URL appears once the pod is ready (or stays pending if no cluster is reachable).',
        );
      else if (body.kind === 'review') setDeployMsg('✓ Sent to a Builder for review (see Deploy reviews).');
      else setDeployMsg('✓ Routine update — published within the approved envelope.');
      reload();
    } catch (e) {
      setDeployMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function promote() {
    if (!id || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${id}/promote`, { method: 'POST' });
      const body = await res.json();
      setMsg(res.ok ? `✓ Promoted to ${visDisplayLabel(body.app.visibility)}.` : `✗ ${body.error}`);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function demote() {
    if (!id || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${id}/demote`, { method: 'POST' });
      const body = await res.json();
      setMsg(res.ok ? `✓ Revoked → ${visDisplayLabel(body.app.visibility)}.` : `✗ ${body.error}`);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function callTool(tool: string) {
    if (!id) return;
    setToolOut('');
    try {
      const res = await fetch(`/api/apps/${id}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, args: tool === 'add_renewal' ? { account: 'NewCo', amount: 9000 } : {} }),
      });
      setToolOut(JSON.stringify(await res.json(), null, 2));
    } catch (e) {
      setToolOut((e as Error).message);
    }
  }

  async function lifecycle(action: string, resource?: unknown) {
    if (!id || busy) return;
    if (action === 'delete' && !confirm('Delete this app? Blocked if a dependency is in use.')) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${id}/lifecycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, resource }),
      });
      const body = await res.json();
      if (!res.ok) setMsg(`✗ ${body.error}`);
      else if (body.deleted) {
        window.location.href = '/software';
        return;
      } else setMsg(`✓ ${action} done.`);
      if (action === 'consume') {
        setConnRef('');
        setConnLabel('');
      }
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Software" crumb="app" />
        <div className="content sw"><div className="stub-page">Loading app…</div></div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <PageHeader title="Software" crumb="app" />
        <div className="content sw">
          <div className="error">{error ?? 'App not found'}</div>
          <div style={{ marginTop: 12 }}><Link className="btn ghost" href="/software">← Back to Software</Link></div>
        </div>
      </>
    );
  }

  const app = data.app;
  const conn = data.connection;
  // Drive the monitor off the DETECTED surface (inferred from what was built),
  // never an upfront kind. Default to both if an old record has no surface yet.
  const surface = app.surface ?? { ui: true, api: true };
  const dep = deployBadge(app.deploy.state);
  const version = app.deploy.releases > 0 ? `v${app.deploy.releases}` : 'Unpublished';
  const canEditCode = roleAtLeast(data.user.role, 'builder');
  const canPromoteUI = promoteLabel(app.visibility);
  // Revoke sharing (demote one rung): Admin revokes Certified→Shared; Builder+ unshares Shared→Personal.
  const canDemoteUI =
    (app.visibility === 'Certified' && data.user.role === 'admin') ||
    (app.visibility === 'Shared' && roleAtLeast(data.user.role, 'builder'));
  const demoteLabel = app.visibility === 'Certified' ? 'Revoke from Company' : 'Unshare';
  const confirmDemoteLabel = app.visibility === 'Certified' ? 'Confirm revoke → Domain' : 'Confirm unshare → My';
  // A deploy is already awaiting a Builder — block re-requesting (it would open a
  // duplicate review card and orphan the pending one). Point to the review inbox.
  const inReview = app.deploy.state === 'review';
  const publishDisabled = busy || inReview;
  const publishLabel = inReview ? 'Awaiting review' : app.deploy.releases > 0 ? 'Publish next release' : 'Publish release';

  return (
    <ConfirmProvider>
      <PageHeader title={app.name} crumb={`Software · ${app.slug}`} />
      <div className="content sw">
        <div className="sw-app-head">
          <div className="sw-app-head-meta">
            <span className={visBadge(app.visibility)}>{visDisplayLabel(app.visibility)}</span>
            {(app.visibility === 'Shared' || app.visibility === 'Certified') ? <DomainTag domain={app.domain} /> : null}
            {/* Prominent promote — role-gated (Personal→Shared: Builder+, Shared→Marketplace: Admin).
                The full "cascades to data/files/MCP" context still lives in the Manage panel below. */}
            {canPromoteUI &&
            ((app.visibility === 'Personal' && roleAtLeast(data.user.role, 'builder')) ||
              (app.visibility === 'Shared' && data.user.role === 'admin')) ? (
              <button className="btn sm" onClick={promote} disabled={busy} title="Promote this app's visibility">
                {busy ? <span className="spin" /> : canPromoteUI}
              </button>
            ) : null}
            {canDemoteUI ? (
              confirmDemote ? (
                <>
                  <button className="btn sm" onClick={() => { setConfirmDemote(false); demote(); }} disabled={busy} style={{ background: 'var(--danger, #b42318)' }}>
                    {busy ? <span className="spin" /> : confirmDemoteLabel}
                  </button>
                  <button className="btn ghost sm" onClick={() => setConfirmDemote(false)} disabled={busy}>Cancel</button>
                </>
              ) : (
                <button className="btn ghost sm" onClick={() => setConfirmDemote(true)} disabled={busy} title="Revoke this app's sharing one rung">
                  {demoteLabel}
                </button>
              )
            ) : null}
            <span className={dep.cls}>{dep.label}</span>
            <span className="badge muted">{version}</span>
            {app.mode === 'offline' ? <span className="badge muted">git not ready</span> : null}
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <div className="sw-modeswitch">
              <button className={mode === 'monitor' ? 'active' : ''} onClick={() => setMode('monitor')}>Monitor</button>
              <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>Edit</button>
            </div>
            <Link className="sw-quiet-link" href="/software">All software</Link>
          </div>
        </div>
        {app.description ? <p className="sw-app-lead">{app.description}</p> : null}

        {mode === 'monitor' ? (
          <>
            {/* What's deployed. */}
            <div className="sw-monitor">
              <div className="sw-monitor-main">
                <div className="sw-monitor-status">
                  <span className={`sw-dot ${app.deploy.state === 'live' ? 'on' : 'off'}`} aria-hidden="true" />
                  <div>
                    <div className="sw-monitor-state">{dep.label} · {version}</div>
                    <div className="sw-monitor-sub mono">{app.subdomain}</div>
                  </div>
                </div>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  {surface.ui ? (
                    app.deploy.previewUrl ? (
                      <a
                        href={app.deploy.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn"
                      >
                        Open app UI ↗
                      </a>
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>
                        App runner pending — provisioning, or no cluster reachable
                      </span>
                    )
                  ) : null}
                  {surface.api ? (
                    <button className={surface.ui ? 'btn ghost' : 'btn'} onClick={() => setShowApi((v) => !v)}>
                      {showApi ? 'Hide API details' : 'API details'}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="sw-health">
                {STAGES.map((s) => (
                  <span key={s} className={stageClass(app.pipeline[s] ?? 'pending')}>
                    {STAGE_LABEL[s]}: {app.pipeline[s] ?? 'pending'}
                  </span>
                ))}
              </div>

              {(surface.api && showApi) ? (
                <div className="sw-api">
                  <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
                    Headless app — its capabilities are exposed as governed MCP tools (principal{' '}
                    <span className="mono">{app.mcpPrincipal}</span>). OpenAPI spec:{' '}
                    {app.manifest.hasOpenApi ? 'present' : 'not declared yet'}.
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Endpoint / tool</th><th>Kind</th><th>Description</th><th /></tr></thead>
                      <tbody>
                        {(conn?.tools ?? app.mcpTools).map((t) => (
                          <tr key={t.name}>
                            <td className="mono">{t.name}</td>
                            <td><span className={`badge ${t.write ? 'warn' : 'ok'}`}>{t.write ? 'write' : 'read'}</span></td>
                            <td className="muted">{t.description}</td>
                            <td><button className="btn ghost sm" onClick={() => callTool(t.name)}>Call</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {toolOut ? <pre className="answer mono" style={{ marginTop: 10, fontSize: 12, whiteSpace: 'pre-wrap' }}>{toolOut}</pre> : null}
                </div>
              ) : null}
            </div>

            {/* Publish / next release. */}
            <div className="sw-publish">
              <div className="sw-publish-row">
                <div>
                  <div className="sw-publish-title">Publish a release</div>
                  <div className="hint" style={{ marginTop: 2 }}>
                    Preview is free and private. Going live in the domain is Builder-reviewed
                    (security scan + requested resources + footprint + diff); routine in-envelope updates ship automatically.
                  </div>
                </div>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <button className="btn ghost" onClick={() => deployAction('preview')} disabled={busy}>Preview</button>
                  <button className="btn lg" onClick={() => deployAction()} disabled={publishDisabled} title={inReview ? 'A deploy is awaiting a Builder in Deploy reviews' : undefined}>
                    {publishLabel}
                  </button>
                </div>
              </div>
              {app.manifest.missing.length > 0 ? (
                <div className="hint" style={{ marginTop: 8 }}>
                  Complete app metadata: <span className="mono">{app.manifest.missing.join(', ')}</span>.
                </div>
              ) : null}
              {deployMsg ? <div className={deployMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 10 }}>{deployMsg}</div> : null}
              <div className="row" style={{ marginTop: 10, gap: 12, alignItems: 'center' }}>
                <button className="btn" onClick={() => setMode('edit')}>Edit this app →</button>
                <Link className="sw-quiet-link" href="/software/reviews">Deploy reviews →</Link>
                {app.repo.fullName ? (
                  <button type="button" className="sw-quiet-link" onClick={() => openTool('forgejo', `${app.name} · repo`, app.repo.fullName)}>
                    Forgejo repo →
                  </button>
                ) : null}
                {app.repo.htmlUrl ? (
                  <a className="sw-quiet-link" href={app.repo.htmlUrl} target="_blank" rel="noreferrer">Native ↗</a>
                ) : null}
              </div>
            </div>

            {/* Secondary, calm management surface. */}
            <button type="button" className="sw-manage-toggle" onClick={() => setManage((v) => !v)} aria-expanded={manage}>
              {manage ? 'Hide manage' : 'Manage'} (promotion, lifecycle, granted resources)
            </button>
            {manage ? (
              <div className="sw-manage">
                <div className="section-title">Granted resources (no raw credentials)</div>
                {app.consumes.length > 0 ? (
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                    {app.consumes.map((c) => (
                      <span key={`${c.kind}:${c.ref}`} className="badge muted mono" style={{ fontSize: 11 }}>
                        {c.kind}:{c.label} ({c.scope})
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>None yet — apps consume governed resources, OPA-scoped, never secrets.</div>
                )}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input type="text" value={connRef} onChange={(e) => setConnRef(e.target.value)} placeholder="Connection ref (e.g. salesforce)" style={{ flex: 1, minWidth: 160 }} />
                  <input type="text" value={connLabel} onChange={(e) => setConnLabel(e.target.value)} placeholder="Label" style={{ flex: 1, minWidth: 120 }} />
                  <select value={connScope} onChange={(e) => setConnScope(e.target.value as 'read' | 'write-bounded')}>
                    <option value="read">read</option>
                    <option value="write-bounded">write-bounded</option>
                  </select>
                  <button className="btn ghost" disabled={busy || !connRef.trim()}
                    onClick={() => lifecycle('consume', { kind: 'connection', ref: connRef.trim(), label: connLabel.trim() || connRef.trim(), scope: connScope })}>
                    Grant
                  </button>
                </div>

                <div className="section-title">Promotion ladder</div>
                <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
                  My → Domain (Builder/Admin) → Company (Admin only). Cascades to the app&apos;s data, files and MCP connection.
                </p>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  {canPromoteUI ? (
                    <button className="btn" onClick={promote} disabled={busy}>{busy ? <span className="spin" /> : canPromoteUI}</button>
                  ) : (
                    <span className="badge vis-certified">In Company</span>
                  )}
                  {canDemoteUI ? (
                    confirmDemote ? (
                      <>
                        <button className="btn sm" onClick={() => { setConfirmDemote(false); demote(); }} disabled={busy} style={{ background: 'var(--danger, #b42318)' }}>
                          {busy ? <span className="spin" /> : confirmDemoteLabel}
                        </button>
                        <button className="btn ghost sm" onClick={() => setConfirmDemote(false)} disabled={busy}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn ghost sm" onClick={() => setConfirmDemote(true)} disabled={busy} title="Revoke this app's sharing one rung">
                        {demoteLabel}
                      </button>
                    )
                  ) : null}
                </div>

                <div className="section-title">Lifecycle</div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn ghost" onClick={() => lifecycle('use-as-data')} disabled={busy || app.usedAsData}>
                    {app.usedAsData ? 'Used as Data ✓' : 'Use as Data'}
                  </button>
                  {/* OS-wide rule: live → Archive; only an ARCHIVED app exposes Delete.
                      Real archived state drives which actions show. */}
                  <LifecycleActions
                    id={app.id}
                    name={app.name}
                    kind="app"
                    visibility={app.visibility === 'Shared' ? 'shared' : app.visibility === 'Certified' ? 'certified' : 'personal'}
                    archived={app.status === 'archived'}
                    handlers={{
                      onArchive: () => lifecycle('archive'),
                      onRestore: () => lifecycle('unarchive'),
                      onDelete: () => lifecycle('delete'),
                    }}
                    // Archive/Delete run through the handlers above; `api` is here
                    // ONLY so Version history reads the git-backed /versions route.
                    api={`/api/apps/${app.id}`}
                    onChanged={() => reload()}
                    showVersions
                  />
                  <span className={`badge ${app.status === 'active' ? 'ok' : 'muted'}`}>{app.status}</span>
                </div>
                {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{msg}</div> : null}
              </div>
            ) : null}
          </>
        ) : (
          /* ---- Edit mode: edit the code directly; use the global “Ask the OS”
                 assistant (top-right) for conversational, agent-driven changes. ---- */
          <div className="sw-edit">
            <div className="sw-edit-bar">
              <span className="sw-edit-hint">
                {canEditCode
                  ? 'Edit the code directly below, or ask the “Ask the OS” assistant (top-right) to build changes for you.'
                  : 'Ask the “Ask the OS” assistant (top-right) to describe the changes you want — it writes code, commits to Forgejo, and prepares a release.'}
              </span>
              <button className="btn lg" onClick={() => deployAction()} disabled={publishDisabled} title={inReview ? 'A deploy is awaiting a Builder in Deploy reviews' : undefined}>
                {publishLabel}
              </button>
            </div>

            {canEditCode ? (
              <CodePanel appId={app.id} repoFullName={app.repo.fullName} />
            ) : (
              <div className="stub-page">
                Use the “Ask the OS” assistant (top-right) to describe what you want changed.
              </div>
            )}
            {deployMsg ? <div className={deployMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{deployMsg}</div> : null}
          </div>
        )}
      </div>
    </ConfirmProvider>
  );
}
