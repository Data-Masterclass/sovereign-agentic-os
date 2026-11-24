/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Approvals inbox — the Governance queue of pending approval requests
 * USER STORY: As a builder or admin I want to see each pending request with its preview and approve,
 *             reject or "approve & remember" it, and as a requester I want to withdraw my own held call,
 *             so that governed actions only run once someone entitled has decided.
 * ARCHITECTURE:
 *   - Client component rendered by `app/(govern)/governance/page.tsx`; reads and decides through
 *     `GET`/`POST /api/governance/approvals`. The role gate is server-side; `mayApprove` /
 *     `mayWithdraw` only decide which buttons are shown.
 *   - Always re-reads the queue after a decision, because a failed effect still commits the decision.
 *   - Approvals raised by a parked agent run show the run and its resume status.
 *   - A dataset certification refused by the personal-data rule (admin setting; the rule lives in
 *     the Data store) shows a confirmation box on that card when the rule allows a confirmation; the
 *     confirmation is posted with the decision as `personalData: {confirmed, reason}`.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';

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
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  decidedBy?: string;
  decidedAt?: string;
  effect?: { applied: string; live: boolean; standingPolicyId?: string };
  createdAt: string;
  mayApprove: boolean;
  /** True for the requester of a parked agent run's pending held call — they may take it back. */
  mayWithdraw?: boolean;
  /** A2: raised by a PARKED agent run — the decision resumes it (the approver authorises, the runner executes). */
  runId?: string;
  systemId?: string;
  node?: string;
  runner?: { id: string; role: string; domains: string[] };
  args?: Record<string, unknown>;
  resume?: { status: 'started' | 'done' | 'refused' | 'failed'; at: string; error?: { code: string; reason: string } };
};

function ResumeBadge({ r }: { r: NonNullable<Approval['resume']> }) {
  if (r.status === 'done') return <span className="badge ok">run resumed</span>;
  if (r.status === 'started') return <span className="badge warn">run resuming…</span>;
  return <span className="badge err" title={r.error?.reason}>{r.status === 'refused' ? `resume refused: ${r.error?.code ?? ''}` : `resume failed: ${r.error?.code ?? ''}`}</span>;
}

function StatusBadge({ s }: { s: Approval['status'] }) {
  if (s === 'approved') return <span className="badge ok">approved</span>;
  if (s === 'rejected') return <span className="badge err">rejected</span>;
  if (s === 'withdrawn') return <span className="badge muted">withdrawn</span>;
  return <span className="badge warn">pending</span>;
}

const PREVIEW_KEYS = ['what', 'who', 'why', 'impact'] as const;

export default function ApprovalsInbox({ focusId = null }: { focusId?: string | null }) {
  const { user } = useUser();
  const [items, setItems] = useState<Approval[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // A certification the personal-data rule refused: which card, whether a confirmation can unlock it.
  const [pdNeed, setPdNeed] = useState<{ id: string; code: string; message: string } | null>(null);
  const [pdConfirm, setPdConfirm] = useState({ confirmed: false, reason: '' });
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
    async (id: string, decision: 'approve' | 'reject' | 'withdraw', remember?: boolean, personalData?: { confirmed: boolean; reason: string }) => {
      const key = `${id}:${decision}${remember ? ':remember' : ''}`;
      setBusy(key);
      setError('');
      try {
        const res = await fetch('/api/governance/approvals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, decision, ...(remember ? { remember: true } : {}), ...(personalData ? { personalData } : {}) }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok && typeof body.code === 'string' && body.code.startsWith('personal_data_')) {
          setPdNeed({ id, code: body.code, message: body.error ?? '' });
        } else if (!res.ok) setError(body.error ?? `Decision failed (HTTP ${res.status}).`);
        else if (pdNeed?.id === id) { setPdNeed(null); setPdConfirm({ confirmed: false, reason: '' }); }
        // RE-READ EITHER WAY. A 502 from the effect still means the decision was COMMITTED:
        // the card's status and its recorded `effect.applied` both changed server-side, and
        // skipping the reload left the row rendering as "pending" with the reason invisible
        // until someone reloaded the page by hand.
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [load, pdNeed],
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
                : a.status === 'withdrawn'
                ? 'var(--border)'
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

                {/* A2: an agent-run approval — the run it parked, and the link to it. */}
                {a.runId && (
                  <div
                    style={{
                      marginTop: 12,
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border)',
                      borderRadius: 7,
                      padding: '8px 10px',
                      fontSize: 12,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 10,
                      alignItems: 'center',
                    }}
                  >
                    <span className="badge">agent run</span>
                    <span>system <span className="mono">{a.systemId ?? '?'}</span></span>
                    <span>agent <span className="mono">{a.node ?? '?'}</span></span>
                    <span>tool <code>{a.tool}</code></span>
                    <span>runs as <span className="mono">{a.runner?.id ?? a.requestedBy}</span></span>
                    {a.systemId ? (
                      <a href={`/agents?system=${encodeURIComponent(a.systemId)}`} style={{ marginLeft: 'auto' }}>
                        Open run ↗
                      </a>
                    ) : null}
                    {a.resume ? <ResumeBadge r={a.resume} /> : a.status === 'pending' ? <span className="muted">run parked until you decide</span> : null}
                    {a.resume?.error ? <div className="muted" style={{ flexBasis: '100%' }}>{a.resume.error.reason}</div> : null}
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

                {a.status === 'withdrawn' && (
                  <div className="hint" style={{ marginTop: 10 }}>
                    Withdrawn by the requester{a.decidedBy ? <> (<span className="mono">{a.decidedBy}</span>)</> : null}
                    {a.decidedAt && <> · {new Date(a.decidedAt).toLocaleString()}</>}. The call was not run.
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
                    ) : null}
                    {a.mayApprove && pdNeed?.id === a.id ? (
                      <div style={{ flexBasis: '100%', marginTop: 8 }} role="alert">
                        <div className="error" style={{ marginBottom: 6 }}>{pdNeed.message}</div>
                        {pdNeed.code === 'personal_data_unprotected' ? (
                          <div className="hint">The personal-data rule is set to Block: mask or hide these columns (or reclassify them) before approving.</div>
                        ) : (
                          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
                              <input type="checkbox" checked={pdConfirm.confirmed} onChange={(e) => setPdConfirm({ ...pdConfirm, confirmed: e.target.checked })} />
                              I confirm the personal-data situation is accepted
                            </label>
                            <input
                              style={{ flex: '1 1 220px' }}
                              placeholder="Reason (recorded in the audit log)"
                              value={pdConfirm.reason}
                              onChange={(e) => setPdConfirm({ ...pdConfirm, reason: e.target.value })}
                            />
                            <button
                              className="btn"
                              disabled={isBusy || !pdConfirm.confirmed || !pdConfirm.reason.trim()}
                              onClick={() => decide(a.id, 'approve', false, pdConfirm)}
                            >
                              Confirm and approve
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                    {a.mayApprove ? null : (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {a.approverRole === 'admin'
                          ? 'Needs an Admin'
                          : a.approverRole === 'domain_admin'
                          ? `Needs a Domain admin of ${a.domain}`
                          : `Needs a Builder of ${a.domain}`}
                      </span>
                    )}
                    {a.mayWithdraw ? (
                      <button
                        className="btn ghost"
                        style={{ padding: '5px 14px' }}
                        disabled={isBusy}
                        title="Take this call back. It will not run, and your agent run continues without it."
                        onClick={() => decide(a.id, 'withdraw')}
                      >
                        {busy === `${a.id}:withdraw` ? <span className="spin" /> : 'Withdraw'}
                      </button>
                    ) : null}
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
