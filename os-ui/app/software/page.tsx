/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import { useApi } from '@/lib/useApi';

type Repo = {
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
};
type Run = {
  id: number;
  status: string;
  branch: string;
  sha: string;
  event: string;
  title: string;
  runNumber: number;
  workflow: string;
  createdAt: string | null;
  url: string;
};
type Data = {
  repos: Repo[];
  demo: { owner: string; repo: string };
  runs: Run[];
  runsError: string;
  consoleUrl: string;
  argocdUrl: string;
};
type Created = { repo: { name: string; fullName: string; htmlUrl: string }; seeded: string[]; seedErrors: string[] };

type AppVisibility = 'Personal' | 'Shared' | 'Certified';
type AppItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  template: string;
  owner: string;
  domain: string;
  visibility: AppVisibility;
  mode: 'live' | 'offline';
  subdomain: string;
};
type AppsData = {
  user: { id: string; role: string };
  apps: AppItem[];
  templates: { key: string; label: string }[];
};

function fmt(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}
function statusClass(s: string): string {
  const v = s.toLowerCase();
  if (v === 'success') return 'badge ok';
  if (v === 'failure' || v === 'error' || v === 'cancelled') return 'badge err';
  if (v === 'running' || v === 'waiting' || v === 'queued') return 'badge warn';
  return 'badge muted';
}

export default function SoftwarePage() {
  const { data, loading, error, reload } = useApi<Data>('/api/software');
  const { data: appsData, loading: appsLoading, reload: reloadApps } = useApi<AppsData>('/api/apps');
  const [tab, setTab] = useState<'apps' | 'overview' | 'add'>('apps');

  // new-app ("New software") form -> per-app page + dedicated chat
  const [appName, setAppName] = useState('');
  const [appDesc, setAppDesc] = useState('');
  const [appTemplate, setAppTemplate] = useState('nextjs-supabase');
  const [appCreating, setAppCreating] = useState(false);
  const [appError, setAppError] = useState('');
  const [newAppId, setNewAppId] = useState('');

  async function createApp() {
    if (!appName.trim() || appCreating) return;
    setAppCreating(true);
    setAppError('');
    setNewAppId('');
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: appName, description: appDesc, template: appTemplate }),
      });
      const body = await res.json();
      if (!res.ok) setAppError(body.error ?? 'Could not create app');
      else {
        setNewAppId(body.app.id);
        setAppName('');
        setAppDesc('');
        reloadApps();
      }
    } catch (e) {
      setAppError((e as Error).message);
    } finally {
      setAppCreating(false);
    }
  }

  // new-software form
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priv, setPriv] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [createError, setCreateError] = useState('');

  async function createRepo() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError('');
    setCreated(null);
    try {
      const res = await fetch('/api/software', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description, private: priv }),
      });
      const body = await res.json();
      if (!res.ok) setCreateError(body.error ?? 'Could not create repo');
      else {
        setCreated(body);
        setName('');
        setDescription('');
        reload();
      }
    } catch (e) {
      setCreateError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <PageHeader title="Software" crumb="create → CI → deploy — Forgejo + Actions + Argo CD" />
      <div className="content">
        <p className="lead">
          Create, test, and deploy software on the sovereign Git path. New repos are created in
          Forgejo with a starter Dockerfile, CI workflow, and k8s manifest; Forgejo Actions builds
          and Argo CD syncs. Credentials stay server-side.
        </p>

        <div className="tabstrip">
          <button className={tab === 'apps' ? 'active' : ''} onClick={() => setTab('apps')}>Apps</button>
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Repositories &amp; CI</button>
          <button className={tab === 'add' ? 'active' : ''} onClick={() => setTab('add')}>New repo (advanced)</button>
        </div>

        {tab === 'apps' ? (
          <>
            <div className="section-title">New software</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Name it, describe what it should do, pick a template. We scaffold a per-app Forgejo
              repo (Next.js + Supabase), auto-generate its MCP + Connection, register its data/files
              as <strong>Personal</strong> artifacts, and open its <strong>own page + build chat</strong>.
            </p>
            <input type="text" value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="App name (e.g. Renewals Tracker)" />
            <input type="text" value={appDesc} onChange={(e) => setAppDesc(e.target.value)} placeholder="What should it do? (e.g. track contract renewals)" style={{ marginTop: 10 }} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <select value={appTemplate} onChange={(e) => setAppTemplate(e.target.value)} style={{ flex: 1 }}>
                {(appsData?.templates ?? [{ key: 'nextjs-supabase', label: 'Next.js + Supabase app' }]).map((t) => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
              <button className="btn" onClick={createApp} disabled={appCreating || !appName.trim()}>
                {appCreating ? <span className="spin" /> : 'New software'}
              </button>
            </div>
            {appError ? <div className="error" style={{ marginTop: 12 }}>{appError}</div> : null}
            {newAppId ? (
              <div className="answer" style={{ marginTop: 14 }}>
                ✓ App created with its own page, build chat, Forgejo repo and auto-generated MCP.
                <div style={{ marginTop: 8 }}>
                  <Link className="btn" href={`/software/${newAppId}`}>Open the app →</Link>
                </div>
              </div>
            ) : null}

            <div className="section-title">Your software</div>
            {appsLoading && !appsData ? (
              <div className="stub-page">Loading apps…</div>
            ) : (appsData?.apps?.length ?? 0) === 0 ? (
              <div className="stub-page">No apps yet — create one above.</div>
            ) : (
              <div className="grid">
                {appsData!.apps.map((a) => (
                  <Link className="card" key={a.id} href={`/software/${a.id}`} style={{ textDecoration: 'none' }}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <h3 style={{ margin: 0 }}>{a.name}</h3>
                      <span className={`badge vis-${a.visibility.toLowerCase()}`}>{a.visibility}</span>
                    </div>
                    <div className="muted" style={{ marginTop: 6 }}>{a.description || 'No description'}</div>
                    <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>
                      {a.template} · {a.owner}/{a.domain} · {a.mode} · {a.subdomain}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        ) : tab === 'add' ? (
          <>
            <div className="section-title">Create a repository</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              This is a <strong>real action</strong>: it calls Forgejo to create the repo and seed
              the starter files. After creation it appears under Overview; push triggers CI; Argo
              deploys the manifest.
            </p>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Repository name (e.g. orders-api)" />
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" style={{ marginTop: 10 }} />
            <div className="row" style={{ marginTop: 12, justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="hint" style={{ marginTop: 0, display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} style={{ width: 'auto' }} />
                Private repository
              </label>
              <button className="btn" onClick={createRepo} disabled={creating || !name.trim()}>
                {creating ? <span className="spin" /> : 'Create repo'}
              </button>
            </div>
            {createError ? <div className="error" style={{ marginTop: 12 }}>{createError}</div> : null}
            {created ? (
              <div className="answer" style={{ marginTop: 14 }}>
                ✓ Created <strong>{created.repo.fullName}</strong> in Forgejo. Seeded:{' '}
                {created.seeded.join(', ') || '(none)'}
                {created.seedErrors.length ? ` · errors: ${created.seedErrors.join(', ')}` : ''}.
                <div style={{ marginTop: 8 }}>
                  <a className="btn ghost" href={created.repo.htmlUrl} target="_blank" rel="noreferrer">Open in Forgejo →</a>
                </div>
              </div>
            ) : null}

            <div className="section-title">Software builder</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Describe the app you want; the builder drafts the repo layout, Dockerfile, CI steps,
              and manifest. Then create the repo above. The builder output is a <strong>plan</strong>;
              the create button is the real action.
            </p>
            <AgentChat
              agent="software-builder"
              label="software builder"
              placeholder="e.g. A Node REST API for orders with a health check and a Postgres connection…"
              starters={[
                'Scaffold a Python FastAPI service with a /health endpoint.',
                'A Next.js dashboard app that reads from the metrics API.',
              ]}
            />
          </>
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="section-title" style={{ margin: '24px 0 13px' }}>Repositories</div>
              <button className="btn ghost" onClick={reload} disabled={loading}>
                {loading ? <span className="spin" /> : 'Refresh'}
              </button>
            </div>
            {error ? <div className="error">{error}</div> : null}
            {data ? (
              <>
                {data.repos.length === 0 ? (
                  <div className="stub-page">No repositories.</div>
                ) : (
                  <div className="grid">
                    {data.repos.map((r) => (
                      <div className="card" key={r.fullName}>
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <h3>{r.name}</h3>
                          <span className={`badge ${r.private ? 'muted' : 'ok'}`}>{r.private ? 'private' : 'public'}</span>
                        </div>
                        <div className="muted">{r.description || 'No description'}</div>
                        <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>
                          {r.fullName} · {r.defaultBranch} · {fmt(r.updatedAt)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="section-title">CI runs · {data.demo.owner}/{data.demo.repo}</div>
                {data.runsError ? (
                  <div className="error">{data.runsError}</div>
                ) : data.runs.length === 0 ? (
                  <div className="stub-page">No CI runs yet for {data.demo.repo}.</div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>#</th><th>Status</th><th>Title</th><th>Event</th><th>Branch</th><th>Commit</th><th>Started</th></tr>
                      </thead>
                      <tbody>
                        {data.runs.map((run) => (
                          <tr key={run.id}>
                            <td>{run.runNumber}</td>
                            <td><span className={statusClass(run.status)}>{run.status}</span></td>
                            <td style={{ whiteSpace: 'normal', maxWidth: 280 }}>{run.title}</td>
                            <td>{run.event}</td>
                            <td>{run.branch}</td>
                            <td className="mono">{run.sha}</td>
                            <td>{fmt(run.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="section-title">Consoles</div>
                <div className="grid">
                  <div className="card row" style={{ alignItems: 'center', gap: 14 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>Forgejo</div>
                      <div className="muted mono">{data.consoleUrl}</div>
                    </div>
                    <a className="btn ghost" href={data.consoleUrl} target="_blank" rel="noreferrer">Open →</a>
                  </div>
                  <div className="card row" style={{ alignItems: 'center', gap: 14 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>Argo CD</div>
                      <div className="muted mono">{data.argocdUrl}</div>
                    </div>
                    <a className="btn ghost" href={data.argocdUrl} target="_blank" rel="noreferrer">Open →</a>
                  </div>
                </div>
              </>
            ) : loading ? (
              <div className="stub-page" style={{ marginTop: 20 }}>Loading software…</div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
