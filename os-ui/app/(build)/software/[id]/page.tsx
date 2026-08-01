/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import { useApi } from '@/lib/useApi';
import type { Role as SessionRole } from '@/lib/core/session';
import type { ReviewCardData } from '@/components/ReviewCard';
import SoftwareBuilder, { type SoftwareApp } from '@/components/software/SoftwareBuilder';

type Tool = { name: string; description: string; write: boolean };
type Connection = { id: string; name: string; principal: string; visibility: SoftwareApp['visibility']; tools: Tool[] } | null;
type Data = { user: { id: string; role: SessionRole }; app: SoftwareApp; connection: Connection };
type Reviews = { cards: ReviewCardData[] };

/**
 * The Software app detail page — a thin host for the guided <SoftwareBuilder> (Describe ·
 * Build · Preview · Publish · Operate on the OS-wide StageShell). The page owns only the
 * data fetch + reload; the builder re-hosts every existing (P0-fixed) body as a stage. The
 * deploy-review card for this app is fetched alongside so the Publish stage can show exactly
 * what a Builder reviews (real security scan + envelope + diff).
 */
export default function AppPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { data, loading, error, reload } = useApi<Data>(`/api/apps/${id ?? ''}`);
  // Deploy-review cards for the caller's domains; we pick the one for THIS app's open card.
  const { data: reviews, reload: reloadReviews } = useApi<Reviews>('/api/software/reviews');

  const reviewCard = useMemo(() => {
    const cid = data?.app.deploy.reviewCardId;
    if (!cid) return null;
    return (reviews?.cards ?? []).find((c) => c.id === cid) ?? null;
  }, [data?.app.deploy.reviewCardId, reviews?.cards]);

  const reloadAll = () => {
    reload();
    reloadReviews();
  };

  // Rename (DISPLAY name only). The store freezes the physical `slug` before the name
  // changes, so the app's repo / container image / subdomain / CI target never move —
  // exactly the Data tab's dataset-rename discipline (parity rollout).
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameErr, setRenameErr] = useState('');
  const rename = async () => {
    const name = nameDraft.trim();
    setRenameErr('');
    if (!name) { setRenaming(false); return; }
    const res = await fetch(`/api/apps/${id ?? ''}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'rename', name }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setRenameErr(d.error ?? 'Rename failed'); return; }
    setRenaming(false);
    reload();
  };

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
  // Owner or platform admin may rename (the route re-checks the full edit-scope gate,
  // incl. an in-domain domain_admin on a Shared/Certified app — this only decides the affordance).
  const canEdit = data.user.id === app.owner || data.user.role === 'admin';

  return (
    <ConfirmProvider>
      <PageHeader title={app.name} crumb={`Software · ${app.slug}`} />
      <div className="content sw">
        {/* Rename — a DISCOVERABLE labelled button (parity with the Data builder). The
            physical slug (repo/image/container/CI identity) stays frozen. */}
        <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 12 }}>
          {renaming ? (
            <span className="rename-inline" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                className="rename-input"
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(false); }}
                aria-label="App name"
              />
              <button className="btn primary sm" onClick={() => void rename()}>Save</button>
              <button className="btn ghost sm" onClick={() => setRenaming(false)}>Cancel</button>
            </span>
          ) : canEdit ? (
            <button
              className="btn ghost sm"
              onClick={() => { setNameDraft(app.name); setRenameErr(''); setRenaming(true); }}
              title="Rename this app (the repo/image/container slug stays stable)"
              aria-label="Rename this app"
            >✎ Rename</button>
          ) : null}
          {renameErr ? <span className="error" style={{ margin: 0 }}>{renameErr}</span> : null}
        </div>
        <SoftwareBuilder
          app={app}
          connection={data.connection}
          user={data.user}
          reviewCard={reviewCard}
          onReload={reloadAll}
        />
      </div>
    </ConfirmProvider>
  );
}
