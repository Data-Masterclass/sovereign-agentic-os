/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import ReviewCard, { type ReviewCardData } from '@/components/ReviewCard';
import { useApi } from '@/lib/useApi';

type Data = { user: { id: string; role: string }; cards: ReviewCardData[]; canReview: boolean };

/**
 * The deploy-review inbox (Software golden path §D). A Builder/Admin reviews
 * pending go-live requests — security scan + requested resources + footprint +
 * diff — and approves or denies. A non-Builder sees the queue read-only.
 */
export default function ReviewsPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/software/reviews');
  const [msg, setMsg] = useState('');

  async function decide(cardId: string, decision: 'approve' | 'deny', note?: string) {
    setMsg('');
    try {
      const res = await fetch(`/api/software/reviews/${cardId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, note }),
      });
      const body = await res.json();
      if (!res.ok) setMsg(`✗ ${body.error}`);
      else setMsg(`✓ Deploy ${body.card.decision} — ${body.app.name} is now ${body.app.deploy.state}.`);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  const pending = (data?.cards ?? []).filter((c) => c.decision === 'pending');
  const decided = (data?.cards ?? []).filter((c) => c.decision !== 'pending');

  return (
    <>
      <PageHeader title="Deploy reviews" crumb="Software · go-live review gate" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ margin: 0 }}>
            Going live in the domain is Builder-reviewed: the scan, the governed resources the app
            requests, its footprint, and the change diff. Preview stays free; routine updates auto-deploy.
          </p>
          <Link className="btn ghost" href="/software">← Software</Link>
        </div>

        {data && !data.canReview ? (
          <div className="hint" style={{ marginTop: 12 }}>
            You can see queued requests, but only a Builder or Administrator in the domain can approve a deploy.
          </div>
        ) : null}
        {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
        {msg ? <div className={msg.startsWith('✓') ? 'answer' : 'error'} style={{ marginTop: 12 }}>{msg}</div> : null}

        <div className="section-title">Pending</div>
        {loading && !data ? (
          <div className="stub-page">Loading reviews…</div>
        ) : pending.length === 0 ? (
          <div className="stub-page">No deploys awaiting review.</div>
        ) : (
          <div className="grid">
            {pending.map((c) => (
              <ReviewCard key={c.id} card={c} canReview={Boolean(data?.canReview)} onDecide={(d, n) => decide(c.id, d, n)} />
            ))}
          </div>
        )}

        {decided.length > 0 ? (
          <>
            <div className="section-title">Recently decided</div>
            <div className="grid">
              {decided.map((c) => (
                <ReviewCard key={c.id} card={c} canReview={false} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
