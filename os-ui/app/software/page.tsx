/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { SCOPE_GROUPS, groupByScope, groupsFromVisibility, scopeCounts, type ScopeKey } from '@/lib/scopes';
import TeamPanel from './TeamPanel';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import type { Visibility as LcVisibility } from '@/lib/lifecycle';

type Visibility = 'Personal' | 'Shared' | 'Certified';
type AppItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  template: string;
  owner: string;
  domain: string;
  visibility: Visibility;
  status: 'active' | 'archived';
  mode: 'live' | 'offline';
  subdomain: string;
  deploy: { state: 'building' | 'preview' | 'review' | 'live'; releases: number };
};

/** App visibility → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (v: Visibility): LcVisibility =>
  v === 'Shared' ? 'shared' : v === 'Certified' ? 'certified' : 'personal';

/** Post an app lifecycle action to its lifecycle route (archive/unarchive/delete). */
async function appLifecycle(id: string, action: 'archive' | 'unarchive' | 'delete') {
  const res = await fetch(`/api/apps/${id}/lifecycle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Action failed');
}
type AppsData = {
  user: { id: string; role: string };
  apps: AppItem[];
};

/** A running app's deploy state → a calm status badge. */
function statusBadge(state: AppItem['deploy']['state']): { cls: string; label: string } {
  switch (state) {
    case 'live':
      return { cls: 'badge ok', label: 'Live' };
    case 'review':
      return { cls: 'badge warn', label: 'In review' };
    case 'preview':
      return { cls: 'badge muted', label: 'Preview' };
    default:
      return { cls: 'badge muted', label: 'Draft' };
  }
}

function versionLabel(releases: number): string {
  return releases > 0 ? `v${releases}` : 'Unpublished';
}

/**
 * Software — the simple, chat-centric start screen. One page: a big home-style
 * "Create new software app" launcher, then the viewer's own running apps as
 * clean tiles. Create scaffolds a sovereign in-cluster Forgejo repo and drops
 * you straight into the build chat + editor (`/software/{id}?mode=edit`).
 */
export default function SoftwarePage() {
  const router = useRouter();
  const { data, loading, reload } = useApi<AppsData>('/api/apps');

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<ScopeKey>('all');

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Could not create the app');
        setCreating(false);
        return;
      }
      // A Forgejo repo is auto-provisioned in-cluster; go build it.
      reload();
      router.push(`/software/${body.app.id}?mode=edit`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  const allApps = data?.apps ?? [];
  const uid = data?.user.id ?? '';
  const appGroups = groupsFromVisibility(allApps);
  const scopedApps = groupByScope(appGroups, uid);
  const appCounts = scopeCounts(appGroups, uid);
  const apps = scopedApps[scope];

  // An app is the caller's to manage when they own it or are an in-domain Admin
  // (the lifecycle route re-checks either way — this only decides whether to show it).
  const role = data?.user.role ?? '';
  const canManage = (a: AppItem) => uid !== '' && (a.owner === uid || role === 'admin');

  return (
    <ConfirmProvider>
      <PageHeader title="Software" crumb="build, chat, deploy — sovereign" tutorial="software" />
      <div className="content sw">
        {/* The big, home-style create launcher. */}
        <div className={`sw-create${open ? ' is-open' : ''}`}>
          {open ? (
            <div className="sw-create-head">
              <div>
                <div className="sw-create-title">Create new software app</div>
                <div className="sw-create-sub">
                  Describe it in chat; the agent writes the code, commits to its own in-cluster
                  Forgejo repo, and ships it. No accounts, no tokens — your code never leaves.
                </div>
              </div>
            </div>
          ) : (
            <button type="button" className="sw-create-head sw-create-trigger" onClick={() => setOpen(true)} aria-expanded={false}>
              <div>
                <div className="sw-create-title">Create new software app</div>
                <div className="sw-create-sub">
                  Describe it in chat; the agent writes the code, commits to its own in-cluster
                  Forgejo repo, and ships it. No accounts, no tokens — your code never leaves.
                </div>
              </div>
              <span className="sw-create-go" aria-hidden="true">+</span>
            </button>
          )}

          {open ? (
            <div className="sw-create-form">
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name your app (e.g. Renewals Tracker)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                }}
              />
              <div className="row" style={{ marginTop: 10, gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
                <button type="button" className="btn ghost" onClick={() => { setOpen(false); setError(''); }} disabled={creating}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={create} disabled={creating || !name.trim()}>
                  {creating ? <span className="spin" /> : 'Create & build'}
                </button>
              </div>
              <p className="sw-create-note">
                No need to pick an app type — describe it in chat and the build agent infers whether
                it needs a UI, an API, or both from what it actually builds. A sovereign Forgejo repo
                is created in-cluster; if git isn&apos;t ready yet you can still build in honest offline mode.
              </p>
              {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
            </div>
          ) : null}
        </div>

        {/* The governed 6-agent Software Delivery Team launcher. */}
        <div style={{ marginTop: 18 }}>
          <TeamPanel onBuilt={reload} />
        </div>

        {/* Software apps — the OS-wide four groups: All · My · Shared · Marketplace. */}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginTop: 30 }}>
          <h2 className="sw-sec-title">Software apps</h2>
          <Link className="sw-quiet-link" href="/software/reviews">Deploy reviews →</Link>
        </div>

        {data ? (
          <div className="seg" style={{ marginTop: 8, marginBottom: 4 }}>
            {SCOPE_GROUPS.map((g) => (
              <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
                {g.label('Software')} ({appCounts[g.key]})
              </button>
            ))}
          </div>
        ) : null}

        {loading && !data ? (
          <div className="stub-page" style={{ marginTop: 12 }}>Loading your apps…</div>
        ) : apps.length === 0 ? (
          <div className="sw-empty">
            <div className="sw-empty-title">
              {scope === 'mine' || scope === 'all' ? 'No apps yet' : scope === 'shared' ? 'Nothing shared yet' : 'Nothing certified yet'}
            </div>
            <div className="sw-empty-sub">
              {scope === 'mine' || scope === 'all'
                ? 'Create your first — it takes one line of chat to get something running.'
                : scope === 'shared' ? 'Promote an app to share it in your domain.' : 'Admins certify apps into the marketplace.'}
            </div>
          </div>
        ) : (
          <div className="sw-apps">
            {apps.map((a) => {
              const s = statusBadge(a.deploy.state);
              const archived = a.status === 'archived';
              return (
                <div className="sw-app-cell" key={a.id}>
                  <Link className="sw-app" href={`/software/${a.id}`}>
                    <div className="sw-app-top">
                      <h3 className="sw-app-name">{a.name}</h3>
                      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                        {archived ? <span className="badge muted">archived</span> : null}
                        <span className={s.cls}>{s.label}</span>
                      </div>
                    </div>
                    <div className="sw-app-desc">{a.description || 'No description yet.'}</div>
                    <div className="sw-app-foot">
                      <span className="sw-app-ver">{versionLabel(a.deploy.releases)}</span>
                      {a.mode === 'offline' ? <span className="badge muted">git not ready</span> : null}
                      <span className="sw-app-open">Open →</span>
                    </div>
                  </Link>
                  {canManage(a) ? (
                    <div className="sw-app-actions">
                      <LifecycleActions
                        id={a.id}
                        name={a.name}
                        kind="app"
                        visibility={lcVis(a.visibility)}
                        archived={archived}
                        api={`/api/apps/${a.id}`}
                        handlers={{
                          onArchive: () => appLifecycle(a.id, 'archive'),
                          onRestore: () => appLifecycle(a.id, 'unarchive'),
                          onDelete: () => appLifecycle(a.id, 'delete'),
                        }}
                        onChanged={reload}
                        compact
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ConfirmProvider>
  );
}
