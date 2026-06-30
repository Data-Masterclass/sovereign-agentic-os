/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import CodePanel from '@/components/CodePanel';
import { useApi } from '@/lib/useApi';

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
  designDecisions: string;
  dataDescriptions: string;
  docs: string;
  chat: ChatMsg[];
  dataArtifactId: string | null;
  files: AppFile[];
  connectionId: string | null;
  mcpPrincipal: string;
  mcpTools: Tool[];
  status: 'active' | 'archived';
  deploy: {
    state: 'building' | 'preview' | 'review' | 'live';
    previewUrl: string | null;
    approved: unknown | null;
    reviewCardId: string | null;
  };
  manifest: { connections: string[]; data: string[]; knowledge: string[]; hasOpenApi: boolean; missing: string[] };
  consumes: { kind: string; ref: string; label: string; scope: string }[];
  usedAsData: boolean;
};
type Connection = { id: string; name: string; principal: string; visibility: Visibility; tools: Tool[] } | null;
type Data = { user: { id: string; role: string }; app: App; connection: Connection };

const STAGES = ['forgejo', 'actions', 'harbor', 'argocd', 'live'] as const;
const STAGE_LABEL: Record<string, string> = {
  forgejo: 'Forgejo',
  actions: 'Actions (CI)',
  harbor: 'Harbor',
  argocd: 'Argo CD',
  live: 'Live subdomain',
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
function promoteLabel(v: Visibility): string | null {
  if (v === 'Personal') return 'Promote to Shared';
  if (v === 'Shared') return 'Promote to Marketplace';
  return null;
}

export default function AppPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { data, loading, error, reload } = useApi<Data>(`/api/apps/${id ?? ''}`);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [toolOut, setToolOut] = useState('');
  const [buildTab, setBuildTab] = useState<'assistant' | 'code'>('assistant');

  async function promote() {
    if (!id || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/apps/${id}/promote`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) setMsg(`✗ ${body.error}`);
      else setMsg(`✓ Promoted to ${body.app.visibility}.`);
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
      const body = await res.json();
      setToolOut(JSON.stringify(body, null, 2));
    } catch (e) {
      setToolOut((e as Error).message);
    }
  }

  const [deployMsg, setDeployMsg] = useState('');
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
      else if (action === 'preview') setDeployMsg(`✓ Private preview running at ${body.app.deploy.previewUrl}`);
      else if (body.kind === 'review') setDeployMsg('✓ Sent to a Builder for review (see Deploy reviews).');
      else setDeployMsg('✓ Routine update — auto-deployed within the approved envelope.');
      reload();
    } catch (e) {
      setDeployMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function lifecycle(action: string, resource?: unknown) {
    if (!id || busy) return;
    if (action === 'delete' && !confirm('Delete this app? Blocked if a dependency is in use.')) return;
    setBusy(true);
    setDeployMsg('');
    try {
      const res = await fetch(`/api/apps/${id}/lifecycle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, resource }),
      });
      const body = await res.json();
      if (!res.ok) setDeployMsg(`✗ ${body.error}`);
      else if (body.deleted) {
        window.location.href = '/software';
        return;
      } else setDeployMsg(`✓ ${action} done.`);
      if (action === 'consume') {
        setConnRef('');
        setConnLabel('');
      }
      reload();
    } catch (e) {
      setDeployMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Software" crumb="app" />
        <div className="content"><div className="stub-page">Loading app…</div></div>
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        <PageHeader title="Software" crumb="app" />
        <div className="content">
          <div className="error">{error ?? 'App not found'}</div>
          <div style={{ marginTop: 12 }}><Link className="btn ghost" href="/software">← Back to Software</Link></div>
        </div>
      </>
    );
  }

  const app = data.app;
  const conn = data.connection;
  const canPromoteUI = promoteLabel(app.visibility);
  // The in-browser code editor mutates the app's repo, so it is gated to
  // Builders + Admins (enforced again server-side in /api/software/[id]/files).
  const canEditCode = data.user.role === 'builder' || data.user.role === 'admin';

  return (
    <>
      <PageHeader title={app.name} crumb={`Software · app · ${app.slug}`} />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className={visBadge(app.visibility)}>{app.visibility}</span>{' '}
            <span className="badge muted">{app.template}</span>{' '}
            <span className={`badge ${app.mode === 'live' ? 'ok' : 'warn'}`}>{app.mode}</span>{' '}
            <span className="muted mono" style={{ fontSize: 12 }}>owner: {app.owner} · {app.domain}</span>
          </div>
          <Link className="btn ghost" href="/software">← All software</Link>
        </div>
        <p className="lead" style={{ marginTop: 12 }}>{app.description || 'No description.'}</p>

        <div className="section-title">Run pipeline</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          Forgejo Actions → Harbor → Argo CD → live subdomain. Status reflects backend reachability;
          Harbor is a default-off heavy workload (CI uses Forgejo&apos;s registry locally).
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {STAGES.map((s) => (
            <span key={s} className={stageClass(app.pipeline[s] ?? 'pending')}>
              {STAGE_LABEL[s]}: {app.pipeline[s] ?? 'pending'}
            </span>
          ))}
        </div>
        <div className="grid" style={{ marginTop: 14 }}>
          <div className="card row" style={{ alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Forgejo repo</div>
              <div className="muted mono" style={{ fontSize: 12 }}>{app.repo.fullName}</div>
              <div className="muted" style={{ fontSize: 12 }}>seeded: {app.repo.seeded.join(', ') || '(offline)'}</div>
            </div>
            <a className="btn ghost" href={app.repo.htmlUrl} target="_blank" rel="noreferrer">Open →</a>
          </div>
          <div className="card">
            <div style={{ fontWeight: 600 }}>Live subdomain</div>
            <div className="muted mono" style={{ fontSize: 12 }}>https://{app.subdomain}</div>
          </div>
        </div>

        <div className="section-title">Deploy &amp; review</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          Iterate in a free <strong>private preview</strong>; going live in the domain needs a
          <strong> Builder review</strong> (security scan + requested resources + footprint + diff).
          Routine in-envelope updates auto-deploy.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className={`badge ${app.deploy.state === 'live' ? 'ok' : app.deploy.state === 'review' ? 'warn' : 'muted'}`}>
            {app.deploy.state}
          </span>
          {app.deploy.previewUrl ? (
            <span className="muted mono" style={{ fontSize: 12 }}>{app.deploy.previewUrl}</span>
          ) : null}
          <button className="btn ghost" onClick={() => deployAction('preview')} disabled={busy}>Start private preview</button>
          <button className="btn" onClick={() => deployAction()} disabled={busy}>Request deploy</button>
          <Link className="btn ghost" href="/software/reviews">Deploy reviews →</Link>
        </div>
        {app.manifest.missing.length > 0 ? (
          <div className="hint" style={{ marginTop: 10 }}>
            Complete your app metadata: <span className="mono">{app.manifest.missing.join(', ')}</span>.
          </div>
        ) : null}
        {deployMsg ? <div className={deployMsg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{deployMsg}</div> : null}

        <div className="section-title">Consumes (granted — no raw credentials)</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          Apps consume the platform&apos;s governed resources (Connections, Data, Knowledge, other apps&apos;
          MCPs), OPA-scoped, never embedding secrets. Adding one broadens scope and re-opens the review on
          the next deploy.
        </p>
        {app.consumes.length > 0 ? (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {app.consumes.map((c) => (
              <span key={`${c.kind}:${c.ref}`} className="badge muted mono" style={{ fontSize: 11 }}>
                {c.kind}:{c.label} ({c.scope})
              </span>
            ))}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>None yet.</div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="text" value={connRef} onChange={(e) => setConnRef(e.target.value)} placeholder="Connection ref (e.g. salesforce)" style={{ flex: 1, minWidth: 160 }} />
          <input type="text" value={connLabel} onChange={(e) => setConnLabel(e.target.value)} placeholder="Label" style={{ flex: 1, minWidth: 120 }} />
          <select value={connScope} onChange={(e) => setConnScope(e.target.value as 'read' | 'write-bounded')}>
            <option value="read">read</option>
            <option value="write-bounded">write-bounded</option>
          </select>
          <button
            className="btn ghost"
            disabled={busy || !connRef.trim()}
            onClick={() => lifecycle('consume', { kind: 'connection', ref: connRef.trim(), label: connLabel.trim() || connRef.trim(), scope: connScope })}
          >
            Grant connection
          </button>
        </div>

        <div className="section-title">Build {app.name}</div>
        {canEditCode ? (
          <div className="tabstrip" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={buildTab === 'assistant' ? 'active' : ''}
              onClick={() => setBuildTab('assistant')}
            >
              AI assistant
            </button>
            <button
              type="button"
              className={buildTab === 'code' ? 'active' : ''}
              onClick={() => setBuildTab('code')}
            >
              Code
            </button>
          </div>
        ) : null}

        {canEditCode && buildTab === 'code' ? (
          <CodePanel appId={app.id} repoFullName={app.repo.fullName} />
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              The dedicated OpenCode build assistant for <strong>{app.name}</strong>, via the governed
              LiteLLM gateway, holding this app&apos;s full context. The conversation is saved under the app.
            </p>
            <AgentChat
              agent="software-app"
              label="build assistant"
              endpoint={`/api/apps/${app.id}/chat`}
              initialMessages={app.chat.map((m) => ({ role: m.role, content: m.content }))}
              placeholder="e.g. Add a status filter to the renewals list and an email reminder 30 days before renews_on…"
              starters={['Add a renewals list view sorted by renews_on.', 'Add an export-to-CSV action.']}
            />
          </>
        )}

        <div className="section-title">Auto-generated MCP — Connection &amp; agent tools</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
          On creation this app auto-generated an MCP, registered as Connection{' '}
          <span className="mono">{conn?.name}</span> (principal <span className="mono">{app.mcpPrincipal}</span>),
          and granted as an agent tool. It appears in Connections and the creator&apos;s agents can call it now.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Tool</th><th>Kind</th><th>Description</th><th>Call</th></tr></thead>
            <tbody>
              {(conn?.tools ?? app.mcpTools).map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td><span className={`badge ${t.write ? 'warn' : 'ok'}`}>{t.write ? 'write' : 'read'}</span></td>
                  <td className="muted">{t.description}</td>
                  <td><button className="btn ghost" onClick={() => callTool(t.name)}>Call (governed)</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {toolOut ? <pre className="answer mono" style={{ marginTop: 12, fontSize: 12, whiteSpace: 'pre-wrap' }}>{toolOut}</pre> : null}

        <div className="section-title">Data &amp; files (Personal to {app.owner})</div>
        <div className="grid">
          <div className="card">
            <div style={{ fontWeight: 600 }}>{app.name} data</div>
            <div className="muted" style={{ fontSize: 12 }}>Operational data product · Supabase · <span className={visBadge(app.visibility)}>{app.visibility}</span></div>
            <div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>artifact: {app.dataArtifactId ?? '(n/a)'}</div>
          </div>
          {app.files.map((f) => (
            <div className="card" key={f.name}>
              <div style={{ fontWeight: 600 }}>{f.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{f.description} · <span className={visBadge(f.visibility)}>{f.visibility}</span></div>
            </div>
          ))}
        </div>

        <div className="section-title">Promotion ladder</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          Personal → Shared (Builder/Admin) → Marketplace (Admin only). Promoting cascades to the
          app&apos;s data, files and MCP connection, and is audited.
        </p>
        {canPromoteUI ? (
          <button className="btn" onClick={promote} disabled={busy}>
            {busy ? <span className="spin" /> : canPromoteUI}
          </button>
        ) : (
          <span className="badge vis-certified">In the Marketplace</span>
        )}
        {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{msg}</div> : null}

        <div className="section-title">Lifecycle</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          <strong>Use as Data</strong> snapshots app data into a Bronze dataset. <strong>Archive</strong>
          {' '}disables the app + its MCP but keeps the data (restorable). <strong>Delete</strong> is
          lineage-aware — blocked while another app depends on it.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn ghost" onClick={() => lifecycle('use-as-data')} disabled={busy || app.usedAsData}>
            {app.usedAsData ? 'Used as Data ✓' : 'Use as Data'}
          </button>
          {app.status === 'archived' ? (
            <button className="btn ghost" onClick={() => lifecycle('unarchive')} disabled={busy}>Restore</button>
          ) : (
            <button className="btn ghost" onClick={() => lifecycle('archive')} disabled={busy}>Archive</button>
          )}
          <button className="btn ghost" onClick={() => lifecycle('delete')} disabled={busy}>Delete</button>
          <span className={`badge ${app.status === 'active' ? 'ok' : 'muted'}`}>{app.status}</span>
        </div>

        <div className="section-title">Authoring front doors</div>
        <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
          Every app is a git repo; author it any way and it flows into the same governed pipeline.
        </p>
        <ul className="muted" style={{ fontSize: 12.5, marginTop: 0, paddingLeft: 18 }}>
          <li>In-app build chat (above) — chat-first, with Monaco for power users.</li>
          <li>Platform MCP — drive create / commit / preview / request-deploy from Claude Code, governed identically.</li>
          <li>Direct git push to the app&apos;s repo.</li>
          <li>Git bridge — import a GitHub/GitLab repo and wrap it as a governed app.</li>
        </ul>

        <div className="section-title">Design decisions</div>
        <pre className="answer mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{app.designDecisions}</pre>
        <div className="section-title">Data descriptions</div>
        <pre className="answer mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{app.dataDescriptions}</pre>
        <div className="section-title">Documentation</div>
        <pre className="answer mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{app.docs}</pre>
      </div>
    </>
  );
}
