/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';

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
  mode: 'live' | 'offline';
  subdomain: string;
  deploy: { state: 'building' | 'preview' | 'review' | 'live'; releases: number };
};
type AppsData = {
  user: { id: string; role: string };
  apps: AppItem[];
  templates: { key: string; label: string }[];
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
  const [template, setTemplate] = useState('nextjs-supabase');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const templates = data?.templates ?? [{ key: 'nextjs-supabase', label: 'Web app (Next.js + Supabase)' }];

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, template }),
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

  const apps = data?.apps ?? [];

  return (
    <>
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
              <div className="row" style={{ marginTop: 10, gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={template} onChange={(e) => setTemplate(e.target.value)} style={{ flex: 1, minWidth: 200 }}>
                  {templates.map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
                <button type="button" className="btn ghost" onClick={() => { setOpen(false); setError(''); }} disabled={creating}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={create} disabled={creating || !name.trim()}>
                  {creating ? <span className="spin" /> : 'Create & build'}
                </button>
              </div>
              <p className="sw-create-note">
                A sovereign Forgejo repo is created in-cluster. If git isn&apos;t ready yet, you can still
                build — the app runs in honest offline mode until the cluster is up.
              </p>
              {error ? <div className="error" style={{ marginTop: 10 }}>{error}</div> : null}
            </div>
          ) : null}
        </div>

        {/* Running apps. */}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginTop: 30 }}>
          <h2 className="sw-sec-title">Personal software apps that are running</h2>
          <Link className="sw-quiet-link" href="/software/reviews">Deploy reviews →</Link>
        </div>

        {loading && !data ? (
          <div className="stub-page" style={{ marginTop: 12 }}>Loading your apps…</div>
        ) : apps.length === 0 ? (
          <div className="sw-empty">
            <div className="sw-empty-title">No apps yet</div>
            <div className="sw-empty-sub">Create your first — it takes one line of chat to get something running.</div>
          </div>
        ) : (
          <div className="sw-apps">
            {apps.map((a) => {
              const s = statusBadge(a.deploy.state);
              return (
                <Link className="sw-app" key={a.id} href={`/software/${a.id}`}>
                  <div className="sw-app-top">
                    <h3 className="sw-app-name">{a.name}</h3>
                    <span className={s.cls}>{s.label}</span>
                  </div>
                  <div className="sw-app-desc">{a.description || 'No description yet.'}</div>
                  <div className="sw-app-foot">
                    <span className="sw-app-ver">{versionLabel(a.deploy.releases)}</span>
                    {a.mode === 'offline' ? <span className="badge muted">git not ready</span> : null}
                    <span className="sw-app-open">Open →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
