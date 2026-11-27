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
import { useTranslations, useFormat } from '@core/i18n/client';

/** `toLocaleString()`'s English form, kept byte-identical; other locales get their own. */
const LEGACY_DT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

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
  const t = useTranslations('governance');
  if (r.status === 'done') return <span className="badge ok">{t('inbox.resume.done')}</span>;
  if (r.status === 'started') return <span className="badge warn">{t('inbox.resume.started')}</span>;
  return <span className="badge err" title={r.error?.reason}>{r.status === 'refused' ? t('inbox.resume.refused', { code: r.error?.code ?? '' }) : t('inbox.resume.failed', { code: r.error?.code ?? '' })}</span>;
}

function StatusBadge({ s }: { s: Approval['status'] }) {
  const t = useTranslations('governance');
  if (s === 'approved') return <span className="badge ok">{t('inbox.status.approved')}</span>;
  if (s === 'rejected') return <span className="badge err">{t('inbox.status.rejected')}</span>;
  if (s === 'withdrawn') return <span className="badge muted">{t('inbox.status.withdrawn')}</span>;
  return <span className="badge warn">{t('inbox.status.pending')}</span>;
}

const PREVIEW_KEYS = ['what', 'who', 'why', 'impact'] as const;

/** A known approval scope in words; anything else is shown as the server sent it. */
const SCOPE_KEYS = { own: 'inbox.scope.own', domain: 'inbox.scope.domain', tenant: 'inbox.scope.tenant' } as const;

export default function ApprovalsInbox({ focusId = null }: { focusId?: string | null }) {
  const t = useTranslations('governance');
  const f = useFormat();
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
      if (!res.ok) setError(body.error ?? t('inbox.loadFailed'));
      else setItems(body.approvals as Approval[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

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
        } else if (!res.ok) setError(body.error ?? t('inbox.decisionFailed', { status: res.status }));
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
    [load, pdNeed, t],
  );

  const pending = (items ?? []).filter((a) => a.status === 'pending').length;

  return (
    <div>
      <div className="section-title">
        {t('inbox.title')}
        {items !== null && (
          <span className={`count-pill${pending === 0 ? ' ok' : ' warn'}`}>
            {t('inbox.pendingCount', { count: pending })}
          </span>
        )}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px' }}
          onClick={load}
        >
          {t('actions.refresh')}
        </button>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {items === null && !error && (
        <div className="stub-page">
          <span className="spin" style={{ marginRight: 10 }} />
          {t('inbox.loading')}
        </div>
      )}

      {items !== null && items.length === 0 && (
        <div className="stub-page">
          {t('inbox.empty')}
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
                      <span className="badge">{a.scope in SCOPE_KEYS ? t(SCOPE_KEYS[a.scope]) : a.scope}</span>
                      {a.effect?.live !== undefined && (
                        <span className={`badge ${a.effect.live ? 'ok' : 'muted'}`}>
                          {a.effect.live ? t('inbox.effect.live') : t('inbox.effect.mock')}
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
                    <div style={{ marginTop: 2 }}>{f.dateTime(a.createdAt, LEGACY_DT)}</div>
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
                            {t(`inbox.preview.${k}`)}
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
                          {t('inbox.preview.scan')}
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
                          {t('inbox.preview.cost')}
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
                          {t('inbox.preview.resources')}
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
                          {t('inbox.preview.diff')}
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
                    <span className="badge">{t('inbox.run.badge')}</span>
                    <span>{t.rich('inbox.run.system', { id: a.systemId ?? '?', mono: (c) => <span className="mono">{c}</span> })}</span>
                    <span>{t.rich('inbox.run.agent', { id: a.node ?? '?', mono: (c) => <span className="mono">{c}</span> })}</span>
                    <span>{t.rich('inbox.run.tool', { tool: a.tool, code: (c) => <code>{c}</code> })}</span>
                    <span>{t.rich('inbox.run.runsAs', { id: a.runner?.id ?? a.requestedBy, mono: (c) => <span className="mono">{c}</span> })}</span>
                    {a.systemId ? (
                      <a href={`/agents?system=${encodeURIComponent(a.systemId)}`} style={{ marginLeft: 'auto' }}>
                        {t('inbox.run.open')}
                      </a>
                    ) : null}
                    {a.resume ? <ResumeBadge r={a.resume} /> : a.status === 'pending' ? <span className="muted">{t('inbox.run.parked')}</span> : null}
                    {a.resume?.error ? <div className="muted" style={{ flexBasis: '100%' }}>{a.resume.error.reason}</div> : null}
                  </div>
                )}

                {/* Effect line */}
                {a.effect && (
                  <div className="hint" style={{ marginTop: 10 }}>
                    {t.rich('inbox.effect.applied', {
                      applied: a.effect.applied,
                      hasBy: a.decidedBy ? 'yes' : 'no',
                      by: a.decidedBy ?? '',
                      hasAt: a.decidedAt ? 'yes' : 'no',
                      at: a.decidedAt ? f.dateTime(a.decidedAt, LEGACY_DT) : '',
                      mono: (c) => <span className="mono">{c}</span>,
                    })}
                  </div>
                )}

                {a.status === 'withdrawn' && (
                  <div className="hint" style={{ marginTop: 10 }}>
                    {t.rich('inbox.withdrawnLine', {
                      hasBy: a.decidedBy ? 'yes' : 'no',
                      by: a.decidedBy ?? '',
                      hasAt: a.decidedAt ? 'yes' : 'no',
                      at: a.decidedAt ? f.dateTime(a.decidedAt, LEGACY_DT) : '',
                      mono: (c) => <span className="mono">{c}</span>,
                    })}
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
                          {busy === `${a.id}:approve` ? <span className="spin" /> : t('inbox.approve')}
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
                              t('inbox.approveRemember')
                            )}
                          </button>
                        )}
                        <button
                          className="btn ghost"
                          style={{ padding: '5px 14px' }}
                          disabled={isBusy}
                          onClick={() => decide(a.id, 'reject')}
                        >
                          {busy === `${a.id}:reject` ? <span className="spin" /> : t('inbox.deny')}
                        </button>
                      </>
                    ) : null}
                    {a.mayApprove && pdNeed?.id === a.id ? (
                      <div style={{ flexBasis: '100%', marginTop: 8 }} role="alert">
                        <div className="error" style={{ marginBottom: 6 }}>{pdNeed.message}</div>
                        {pdNeed.code === 'personal_data_unprotected' ? (
                          <div className="hint">{t('inbox.personalData.blocked')}</div>
                        ) : (
                          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}>
                              <input type="checkbox" checked={pdConfirm.confirmed} onChange={(e) => setPdConfirm({ ...pdConfirm, confirmed: e.target.checked })} />
                              {t('inbox.personalData.confirm')}
                            </label>
                            <input
                              style={{ flex: '1 1 220px' }}
                              placeholder={t('inbox.personalData.reasonPlaceholder')}
                              value={pdConfirm.reason}
                              onChange={(e) => setPdConfirm({ ...pdConfirm, reason: e.target.value })}
                            />
                            <button
                              className="btn"
                              disabled={isBusy || !pdConfirm.confirmed || !pdConfirm.reason.trim()}
                              onClick={() => decide(a.id, 'approve', false, pdConfirm)}
                            >
                              {t('inbox.personalData.approve')}
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                    {a.mayApprove ? null : (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {a.approverRole === 'admin'
                          ? t('inbox.needs.admin')
                          : a.approverRole === 'domain_admin'
                          ? t('inbox.needs.domainAdmin', { domain: a.domain })
                          : t('inbox.needs.builder', { domain: a.domain })}
                      </span>
                    )}
                    {a.mayWithdraw ? (
                      <button
                        className="btn ghost"
                        style={{ padding: '5px 14px' }}
                        disabled={isBusy}
                        title={t('inbox.withdrawTitle')}
                        onClick={() => decide(a.id, 'withdraw')}
                      >
                        {busy === `${a.id}:withdraw` ? <span className="spin" /> : t('inbox.withdraw')}
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
