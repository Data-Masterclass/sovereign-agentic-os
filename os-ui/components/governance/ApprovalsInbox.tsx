/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { anchorAttr, ANCHORS } from '@/lib/tutorials';
import { roleAtLeast } from '@/lib/core/session';

type Preview = {
  what: string;
  who: string;
  why: string;
  impact: string;
  scan?: string;
  resources?: string[];
  cost?: string;
  diff?: string;
};

type Approval = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  agent: string;
  domain: string;
  requestedBy: string;
  tool: string;
  payload: unknown;
  approverRole: 'builder' | 'domain_admin' | 'admin';
  scope: 'own' | 'domain' | 'tenant';
  rememberable: boolean;
  source: string;
  preview?: Preview;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy?: string;
  decidedAt?: string;
  effect?: { applied: string; live: boolean; standingPolicyId?: string };
  createdAt: string;
  mayApprove: boolean;
};

function StatusBadge({ s }: { s: Approval['status'] }) {
  if (s === 'approved') return <span className="badge ok">approved</span>;
  if (s === 'rejected') return <span className="badge err">rejected</span>;
  return <span className="badge warn">pending</span>;
}

const PREVIEW_KEYS = ['what', 'who', 'why', 'impact'] as const;

export default function ApprovalsInbox({ focusId = null }: { focusId?: string | null }) {
  const { user } = useUser();
  const [items, setItems] = useState<Approval[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const focusRef = useRef<HTMLDivElement | null>(null);

  const isBuilderOrAdmin = !!user && roleAtLeast(user.role, 'builder');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/governance/approvals', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load approvals');
      else setItems(body.approvals as Approval[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Deep-link focus: once the queue is in, scroll the just-filed request into
  // view (a tab's "Go to Policies & Approvals →" carried ?focus=<id>).
  useEffect(() => {
    if (focusId && items && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusId, items]);

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject', remember?: boolean) => {
      const key = `${id}:${decision}${remember ? ':remember' : ''}`;
      setBusy(key);
      setError('');
      try {
        const res = await fetch('/api/governance/approvals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, decision, ...(remember ? { remember: true } : {}) }),
        });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Decision failed');
        else await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const pending = (items ?? []).filter((a) => a.status === 'pending').length;

  return (
    <div>
      <div className="section-title">
        Approval inbox
        {items !== null && (
          <span className={`count-pill${pending === 0 ? ' ok' : ' warn'}`}>
            {pending} pending
          </span>
        )}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px' }}
          onClick={load}
        >
          Refresh
        </button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {items === null && !error && (
        <div className="stub-page">
          <span className="spin" style={{ marginRight: 10 }} />
          Loading approvals…
        </div>
      )}

      {items !== null && items.length === 0 && (
        <div className="stub-page">
          Queue is empty — no pending approval requests.
        </div>
      )}

      {items && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((a) => {
            const accentColor =
              a.status === 'approved'
                ? 'var(--teal)'
                : a.status === 'rejected'
                ? 'var(--danger)'
                : 'var(--gold)';
            const isBusy = busy.startsWith(a.id + ':');
            const isFocused = focusId === a.id;

            return (
              <div
                key={a.id}
                ref={isFocused ? focusRef : undefined}
                className={`card${isFocused ? ' focus-ring' : ''}`}
                style={{
                  borderLeft: `3px solid ${accentColor}`,
                  ...(isFocused ? { boxShadow: '0 0 0 2px var(--gold)' } : {}),
                }}
              >
                {/* Header */}
                <div
                  className="row"
                  style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <StatusBadge s={a.status} />
                      <span className="badge">{a.kind}</span>
                      <span className="badge">{a.scope}</span>
                      {a.effect?.live !== undefined && (
                        <span className={`badge ${a.effect.live ? 'ok' : 'muted'}`}>
                          {a.effect.live ? 'live' : 'mock'}
                        </span>
                      )}
                    </div>
                    <div style={{ fontWeight: 600, marginTop: 8, fontSize: 14 }}>{a.title}</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{a.detail}</div>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-faint)',
                      whiteSpace: 'nowrap',
                      textAlign: 'right',
                      flexShrink: 0,
                    }}
                  >
                    <div className="mono">{a.agent}</div>
                    <div style={{ marginTop: 2 }}>{a.domain}</div>
                    <div style={{ marginTop: 2 }}>{new Date(a.createdAt).toLocaleString()}</div>
                  </div>
                </div>

                {/* Preview grid */}
                {a.preview && (
                  <div
                    style={{
                      marginTop: 12,
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                      gap: 8,
                    }}
                  >
                    {PREVIEW_KEYS.map((k) => {
                      const val = a.preview![k];
                      if (!val) return null;
                      return (
                        <div
                          key={k}
                          style={{
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border)',
                            borderRadius: 7,
                            padding: '8px 10px',
                          }}
                        >
                          <div
                            style={{
                              fontFamily: 'var(--font-head)',
                              fontSize: 9,
                              textTransform: 'uppercase',
                              letterSpacing: '1px',
                              color: 'var(--gold-text)',
                              marginBottom: 3,
                            }}
                          >
                            {k}
                          </div>
                          <div style={{ fontSize: 12, lineHeight: 1.45 }}>{val}</div>
                        </div>
                      );
                    })}

                    {a.preview.scan && (
                      <div
                        style={{
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          borderRadius: 7,
                          padding: '8px 10px',
                        }}
                      >
                        <div
                          style={{
                            fontFamily: 'var(--font-head)',
                            fontSize: 9,
                            textTransform: 'uppercase',
                            letterSpacing: '1px',
                            color: 'var(--gold-text)',
                            marginBottom: 3,
                          }}
                        >
                          scan
                        </div>
                        <div style={{ fontSize: 12 }}>{a.preview.scan}</div>
                      </div>
                    )}

                    {a.preview.cost && (
                      <div
                        style={{
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          borderRadius: 7,
                          padding: '8px 10px',
                        }}
                      >
                        <div
                          style={{
                            fontFamily: 'var(--font-head)',
                            fontSize: 9,
                            textTransform: 'uppercase',
                            letterSpacing: '1px',
                            color: 'var(--gold-text)',
                            marginBottom: 3,
                          }}
                        >
                          est. cost
                        </div>
                        <div style={{ fontSize: 12 }}>{a.preview.cost}</div>
                      </div>
                    )}

                    {a.preview.resources && a.preview.resources.length > 0 && (
                      <div
                        style={{
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          borderRadius: 7,
                          padding: '8px 10px',
                          gridColumn: 'span 2',
                        }}
                      >
                        <div
                          style={{
                            fontFamily: 'var(--font-head)',
                            fontSize: 9,
                            textTransform: 'uppercase',
                            letterSpacing: '1px',
                            color: 'var(--gold-text)',
                            marginBottom: 4,
                          }}
                        >
                          resources
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {a.preview.resources.map((r, i) => (
                            <span key={i} className="chip">{r}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    {a.preview.diff && (
                      <div
                        style={{
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          borderRadius: 7,
                          padding: '8px 10px',
                          gridColumn: '1 / -1',
                        }}
                      >
                        <div
                          style={{
                            fontFamily: 'var(--font-head)',
                            fontSize: 9,
                            textTransform: 'uppercase',
                            letterSpacing: '1px',
                            color: 'var(--gold-text)',
                            marginBottom: 3,
                          }}
                        >
                          diff
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11,
                            overflowX: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            fontFamily:
                              "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace",
                          }}
                        >
                          {a.preview.diff}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                {/* Effect line */}
                {a.effect && (
                  <div className="hint" style={{ marginTop: 10 }}>
                    Applied: {a.effect.applied}
                    {a.decidedBy && (
                      <> · by <span className="mono">{a.decidedBy}</span></>
                    )}
                    {a.decidedAt && <> · {new Date(a.decidedAt).toLocaleString()}</>}
                  </div>
                )}

                {/* Action row */}
                {a.status === 'pending' && (
                  <div
                    className="row"
                    style={{
                      marginTop: 14,
                      paddingTop: 12,
                      borderTop: '1px solid var(--border)',
                      gap: 8,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    {a.mayApprove ? (
                      <>
                        <button
                          className="btn"
                          style={{ padding: '5px 14px' }}
                          disabled={isBusy}
                          onClick={() => decide(a.id, 'approve')}
                          {...anchorAttr(ANCHORS.governance.approve)}
                        >
                          {busy === `${a.id}:approve` ? <span className="spin" /> : 'Approve'}
                        </button>
                        {a.rememberable && (
                          <button
                            className="btn"
                            style={{
                              padding: '5px 14px',
                              background:
                                'linear-gradient(180deg, var(--teal), var(--teal-dim))',
                              boxShadow: '0 6px 18px -10px rgba(0,128,128,0.6)',
                            }}
                            disabled={isBusy}
                            onClick={() => decide(a.id, 'approve', true)}
                            {...anchorAttr(ANCHORS.governance.remember)}
                          >
                            {busy === `${a.id}:approve:remember` ? (
                              <span className="spin" />
                            ) : (
                              'Approve & remember'
                            )}
                          </button>
                        )}
                        <button
                          className="btn ghost"
                          style={{ padding: '5px 14px' }}
                          disabled={isBusy}
                          onClick={() => decide(a.id, 'reject')}
                        >
                          {busy === `${a.id}:reject` ? <span className="spin" /> : 'Deny'}
                        </button>
                      </>
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {a.approverRole === 'admin'
                          ? 'Needs an Admin'
                          : a.approverRole === 'domain_admin'
                          ? `Needs a Domain admin of ${a.domain}`
                          : `Needs a Builder of ${a.domain}`}
                      </span>
                    )}
                    <span
                      className="mono muted"
                      style={{ marginLeft: 'auto', fontSize: 11 }}
                    >
                      {a.requestedBy} · <code>{a.tool}</code>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
