/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';

/**
 * Governance approval queue (golden path §7). Held write-backs — connection
 * writes, knowledge certifies, file promotions — surface here with their context
 * and trace. A Builder/Admin approves (which APPLIES the write, attributed to the
 * agent + the human) or rejects. Participants see the queue read-only.
 */

type Approval = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  agent: string;
  domain: string;
  requestedBy: string;
  tool: string;
  traceId?: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  createdAt: string;
};

function statusBadge(s: Approval['status']) {
  if (s === 'approved') return <span className="badge ok">approved</span>;
  if (s === 'rejected') return <span className="badge err">rejected</span>;
  return <span className="badge warn">pending</span>;
}

export default function ApprovalQueue() {
  const { user } = useUser();
  const [items, setItems] = useState<Approval[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const canApprove = !!user && roleAtLeast(user.role, 'builder');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/agent/approvals', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load approvals');
      else setItems(body.approvals as Approval[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject') => {
      setBusy(id);
      setError('');
      try {
        const res = await fetch('/api/agent/approvals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, decision }),
        });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Decision failed');
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const pending = (items ?? []).filter((a) => a.status === 'pending');

  return (
    <div style={{ marginBottom: 28 }}>
      <div className="section-title">
        Approval queue · held write-backs
        {items ? (
          <span className={`count-pill${pending.length === 0 ? ' ok' : ' warn'}`}>{pending.length} pending</span>
        ) : null}
        <button className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 12px' }} onClick={load}>
          Refresh
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        High-stakes actions an agent proposed — external connection writes, knowledge certifies —
        are paused here for a Builder/Administrator. Approving applies the write, attributed to the
        agent key + the approving human, and logs it to Langfuse.
      </p>

      {error ? <div className="error">{error}</div> : null}

      {items && items.length === 0 ? (
        <div className="stub-page">No held actions. Run the Sales Assistant and ask it to update the CRM to populate this queue.</div>
      ) : null}

      {items && items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Action</th><th>Agent</th><th>Tool</th><th>Requested by</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{a.title}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{a.detail}</div>
                    {a.traceId ? <div className="mono muted" style={{ fontSize: 11 }}>trace …{a.traceId.slice(-8)}</div> : null}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{a.agent}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{a.tool}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{a.requestedBy}</td>
                  <td style={{ textAlign: 'center' }}>
                    {statusBadge(a.status)}
                    {a.decidedBy ? <div className="muted" style={{ fontSize: 11 }}>by {a.decidedBy}</div> : null}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {a.status === 'pending' && canApprove ? (
                      <>
                        <button className="btn" style={{ padding: '4px 10px', marginRight: 6 }} disabled={busy === a.id} onClick={() => decide(a.id, 'approve')}>
                          {busy === a.id ? <span className="spin" /> : 'Approve'}
                        </button>
                        <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === a.id} onClick={() => decide(a.id, 'reject')}>
                          Reject
                        </button>
                      </>
                    ) : a.status === 'pending' ? (
                      <span className="muted" style={{ fontSize: 12 }}>Builder approval</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
