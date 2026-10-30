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

export default function EgressView() {
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
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else { setPosture(body.posture); setAllowlist(body.allowlist ?? []); setRequests(body.requests ?? []); }
    } catch (e) { setError((e as Error).message); } finally { setBusyLoad(false); }
  }, []);
  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const post = useCallback(async (payload: Record<string, unknown>, key: string) => {
    setBusy(key); setError('');
    try {
      const res = await fetch('/api/platform-admin/security', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Action failed');
      else await load();
    } finally { setBusy(''); }
  }, [load]);

  // Fail closed while the role is unresolved: render nothing rather than flash
  // the allowlist at a builder.
  if (loading || !allowed) return null;

  return (
    <>
      <p className="lead">
        The tenant’s sovereignty posture: the Admin-curated <strong>egress allowlist</strong>, secrets-manager
        status, data residency, the OPA policy-bundle version, and audit retention — no raw secrets, ever.
        Builders raise egress requests; you approve them below, and every decision compiles into the same
        OPA bundle the Policies tab shows.
      </p>
      {error ? <div className="error">{error}</div> : null}

      {posture ? (
        <div className="pa-kpis">
          <div className="card pa-kpi"><span className="k-label">Data residency</span><span className="k-value" style={{ fontSize: 18 }}>{posture.residency}</span><span className="k-sub">in-region only</span></div>
          <div className="card pa-kpi"><span className="k-label">Secrets manager</span><span className="k-value" style={{ fontSize: 18 }}>{posture.secretsManager.status}</span><span className="k-sub">{posture.secretsManager.secretsStored} stored · {posture.secretsManager.backend}</span></div>
          <div className="card pa-kpi"><span className="k-label">OPA policy bundle</span><span className="k-value" style={{ fontSize: 18 }}>{posture.opaBundle.version}</span><span className="k-sub">compiled {new Date(posture.opaBundle.lastCompiled).toLocaleString()}</span></div>
          <div className="card pa-kpi"><span className="k-label">Audit retention</span><span className="k-value">{posture.auditRetentionDays}d</span><span className="k-sub">shared record</span></div>
          <div className="card pa-kpi"><span className="k-label">Certificates</span><span className="k-value" style={{ fontSize: 18 }}>{posture.certs.status}</span><span className="k-sub">{posture.certs.daysToExpiry}d · {posture.certs.issuer}</span></div>
        </div>
      ) : busyLoad ? <div className="stub-page">Loading posture…</div> : null}

      <div className="section-title" style={{ marginTop: 8 }}>Egress allowlist<span className="count-pill">{allowlist.length}</span></div>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input style={{ flex: '1 1 240px' }} value={host} onChange={(e) => setHost(e.target.value)} placeholder="external host (e.g. api.example.com)" />
          <button className="btn" disabled={busy === 'add' || !host.trim()} onClick={() => { post({ op: 'allow-add', host }, 'add'); setHost(''); }}>
            {busy === 'add' ? <span className="spin" /> : 'Add to allowlist'}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          {allowlist.map((h) => (
            <span className="chip" key={h}>
              {h}
              <button className="chip-x" onClick={() => post({ op: 'allow-remove', host: h }, h)} title="remove" style={{ marginLeft: 6 }}>×</button>
            </span>
          ))}
        </div>
        <div className="hint" style={{ marginTop: 8 }}>Compiles to the OPA <code>egress_allow</code> resource + the egress proxy / Cilium FQDN policy.</div>
      </div>

      <div className="section-title">Builder egress requests<span className="count-pill">{requests.filter((r) => r.status === 'pending').length}</span></div>
      {requests.length === 0 ? <div className="hint">No requests.</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Host</th><th>Reason</th><th>By</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="mono"><strong>{r.host}</strong></td>
                  <td style={{ whiteSpace: 'normal' }}>{r.reason}<div className="muted" style={{ fontSize: 11 }}>{r.domain}</div></td>
                  <td>{r.requestedBy}</td>
                  <td><span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'err' : 'muted'}`}>{r.status}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {r.status === 'pending' ? (
                      <>
                        <button className="btn ghost" style={{ padding: '4px 10px', marginRight: 6 }} disabled={busy === r.id} onClick={() => post({ op: 'request-decide', id: r.id, decision: 'approved' }, r.id)}>Approve</button>
                        <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === r.id} onClick={() => post({ op: 'request-decide', id: r.id, decision: 'rejected' }, r.id)}>Reject</button>
                      </>
                    ) : <span className="muted" style={{ fontSize: 11 }}>decided</span>}
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
