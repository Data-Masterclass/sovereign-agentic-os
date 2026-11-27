/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        governance
 * FEATURE:    Security & Egress — the sovereign posture board and the egress allowlist, in Governance
 * USER STORY: As a platform admin I want to decide which external hosts this tenant may reach where
 *             I already approve requests and read policy, because an allowlist entry IS a policy
 *             decision and it compiles into the same OPA bundle shown one tab over.
 * ARCHITECTURE:
 *   - Markup carried over unchanged from app/(govern)/platform/security/page.tsx (2026-10-30 move,
 *     not a redesign); the lib moved with it to tabs/governance/lib/egress.ts.
 *   - FAIL-CLOSED gate: Governance is minRole 'builder', so this renders NOTHING until useUser()
 *     resolves a role of at least 'admin' — a builder never sees, nor flashes, the allowlist or the
 *     approve/reject controls. The real enforcement is GET/POST /api/platform-admin/security, which
 *     stays adminCtx()-gated.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import type { EgressRequest, SecurityPosture } from '@tabs/governance/lib/egress';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';

/** `toLocaleString()`'s English form, kept byte-identical; other locales get their own. */
const LEGACY_DT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

/** Known status words in the user's language; anything else is shown as the server sent it. */
const STATUS_KEYS = {
  healthy: 'egress.status.healthy', degraded: 'egress.status.degraded',
  valid: 'egress.status.valid', expiring: 'egress.status.expiring', expired: 'egress.status.expired',
  pending: 'egress.status.pending', approved: 'egress.status.approved', rejected: 'egress.status.rejected',
} as const;

export default function EgressView() {
  const t = useTranslations('governance');
  const msg = useServerMessage();
  const f = useFormat();
  const status = (s: string) => (s in STATUS_KEYS ? t(STATUS_KEYS[s as keyof typeof STATUS_KEYS]) : s);
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  const allowed = role !== null && roleAtLeast(role, 'admin');

  const [posture, setPosture] = useState<SecurityPosture | null>(null);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [requests, setRequests] = useState<EgressRequest[]>([]);
  const [host, setHost] = useState('');
  const [error, setError] = useState('');
  const [busyLoad, setBusyLoad] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setBusyLoad(true); setError('');
    try {
      const res = await fetch('/api/platform-admin/security', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(msg(body, t('egress.loadFailed')));
      else { setPosture(body.posture); setAllowlist(body.allowlist ?? []); setRequests(body.requests ?? []); }
    } catch (e) { setError((e as Error).message); } finally { setBusyLoad(false); }
  }, [t, msg]);
  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const post = useCallback(async (payload: Record<string, unknown>, key: string) => {
    setBusy(key); setError('');
    try {
      const res = await fetch('/api/platform-admin/security', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) setError(msg(body, t('egress.actionFailed')));
      else await load();
    } finally { setBusy(''); }
  }, [load, t, msg]);

  // Fail closed while the role is unresolved: render nothing rather than flash
  // the allowlist at a builder.
  if (loading || !allowed) return null;

  return (
    <>
      {error ? <div className="error">{error}</div> : null}

      {posture ? (
        <div className="pa-kpis">
          <div className="card pa-kpi"><span className="k-label">{t('egress.posture.residency')}</span><span className="k-value" style={{ fontSize: 18 }}>{posture.residency}</span><span className="k-sub">{t('egress.posture.inRegion')}</span></div>
          <div className="card pa-kpi"><span className="k-label">{t('egress.posture.secrets')}</span><span className="k-value" style={{ fontSize: 18 }}>{status(posture.secretsManager.status)}</span><span className="k-sub">{t('egress.posture.secretsStored', { count: posture.secretsManager.secretsStored, backend: posture.secretsManager.backend })}</span></div>
          <div className="card pa-kpi"><span className="k-label">{t('egress.posture.opa')}</span><span className="k-value" style={{ fontSize: 18 }}>{posture.opaBundle.version}</span><span className="k-sub">{t('egress.posture.compiled', { at: f.dateTime(posture.opaBundle.lastCompiled, LEGACY_DT) })}</span></div>
          <div className="card pa-kpi"><span className="k-label">{t('egress.posture.audit')}</span><span className="k-value">{t('egress.posture.days', { days: posture.auditRetentionDays })}</span><span className="k-sub">{t('egress.posture.sharedRecord')}</span></div>
          <div className="card pa-kpi"><span className="k-label">{t('egress.posture.certs')}</span><span className="k-value" style={{ fontSize: 18 }}>{status(posture.certs.status)}</span><span className="k-sub">{t('egress.posture.certsSub', { days: posture.certs.daysToExpiry, issuer: posture.certs.issuer })}</span></div>
        </div>
      ) : busyLoad ? <div className="stub-page">{t('egress.loading')}</div> : null}

      <div className="section-title" style={{ marginTop: 8 }}>{t('egress.allowlist.title')}<span className="count-pill">{allowlist.length}</span></div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input style={{ flex: '1 1 240px' }} value={host} onChange={(e) => setHost(e.target.value)} placeholder={t('egress.allowlist.placeholder')} />
          <button className="btn" disabled={busy === 'add' || !host.trim()} onClick={() => { post({ op: 'allow-add', host }, 'add'); setHost(''); }}>
            {busy === 'add' ? <span className="spin" /> : t('egress.allowlist.add')}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          {allowlist.map((h) => (
            <span className="chip" key={h}>
              {h}
              <button className="chip-x" onClick={() => post({ op: 'allow-remove', host: h }, h)} title={t('egress.allowlist.remove')} style={{ marginLeft: 6 }}>×</button>
            </span>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>{t.rich('egress.allowlist.compiles', { resource: 'egress_allow', code: (c) => <code>{c}</code> })}</div>
      </div>

      <div className="section-title">{t('egress.requests.title')}<span className="count-pill">{requests.filter((r) => r.status === 'pending').length}</span></div>
      {requests.length === 0 ? <div className="hint">{t('egress.requests.none')}</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t('egress.requests.th.host')}</th><th>{t('egress.requests.th.reason')}</th><th>{t('egress.requests.th.by')}</th><th>{t('egress.requests.th.status')}</th><th></th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="mono"><strong>{r.host}</strong></td>
                  <td style={{ whiteSpace: 'normal' }}>{r.reason}<div className="muted" style={{ fontSize: 11 }}>{r.domain}</div></td>
                  <td>{r.requestedBy}</td>
                  <td><span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'err' : 'muted'}`}>{status(r.status)}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {r.status === 'pending' ? (
                      <>
                        <button className="btn ghost" style={{ padding: '4px 10px', marginRight: 6 }} disabled={busy === r.id} onClick={() => post({ op: 'request-decide', id: r.id, decision: 'approved' }, r.id)}>{t('egress.requests.approve')}</button>
                        <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === r.id} onClick={() => post({ op: 'request-decide', id: r.id, decision: 'rejected' }, r.id)}>{t('egress.requests.reject')}</button>
                      </>
                    ) : <span className="muted" style={{ fontSize: 11 }}>{t('egress.requests.decided')}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
