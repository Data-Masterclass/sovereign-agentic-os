/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type Role = 'participant' | 'builder' | 'admin';
type Status = 'active' | 'invited' | 'deactivated';
type AccessUser = {
  id: string;
  name: string;
  domains: string[];
  role: Role;
  status: Status;
  active: boolean;
};
type Sso = { enabled: boolean; provider: string; issuerUrl: string; scim: boolean };
const ROLES: Role[] = ['participant', 'builder', 'admin'];
const STATUS_BADGE: Record<Status, string> = { active: 'ok', invited: 'muted', deactivated: 'err' };

export default function AccessPage() {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [sso, setSso] = useState<Sso | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('participant');
  const [domainText, setDomainText] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/access', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else {
        setUsers(body.users ?? []);
        setDomains(body.domains ?? []);
        setSso(body.sso ?? null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const invite = useCallback(async () => {
    if (!id.trim() || !name.trim()) return;
    setBusy('invite');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id, name, role,
          domains: domainText.split(',').map((d) => d.trim()).filter(Boolean),
        }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Invite failed');
      else { setId(''); setName(''); setDomainText(''); setRole('participant'); await load(); }
    } finally {
      setBusy('');
    }
  }, [id, name, role, domainText, load]);

  const patch = useCallback(async (u: AccessUser, body: Record<string, unknown>) => {
    setBusy(u.id);
    setError('');
    try {
      const res = await fetch(`/api/platform-admin/access/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Update failed');
      } else await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  const offboard = useCallback(async (u: AccessUser) => {
    setBusy(u.id);
    setError('');
    try {
      const res = await fetch(`/api/platform-admin/access/${u.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Offboard failed');
      } else await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  return (
    <>
      <PageHeader title="Users & Access" crumb="platform · org-wide identity (via Ory)" />
      <div className="content">
        <p className="lead">
          The <strong>org-wide</strong> identity lifecycle — invite and deactivate people, grant tenant
          Admin, set initial domain memberships. In-domain role changes are delegated to Builders in{' '}
          <a href="/governance">Governance</a>; this surface stays at the tenant boundary.
        </p>

        <div className="hint" style={{ marginBottom: 14 }}>
          SSO {sso?.enabled ? <span className="badge ok">enabled</span> : <span className="badge muted">off</span>}
          {' · '}SCIM {sso?.scim ? <span className="badge ok">on</span> : <span className="badge muted">off</span>}
          {' · '}<a href="/platform/settings">configure in Settings</a>
        </div>

        <div className="section-title">Invite user</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 140px' }} value={id} onChange={(e) => setId(e.target.value)} placeholder="email / login" />
            <input style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="full name" />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input style={{ flex: '1 1 220px' }} value={domainText} onChange={(e) => setDomainText(e.target.value)} placeholder="domains, comma-separated" />
            <button className="btn" onClick={invite} disabled={busy === 'invite' || !id.trim() || !name.trim()}>
              {busy === 'invite' ? <span className="spin" /> : 'Invite user'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Ory sends the credential — you never see a password.
            {domains.length ? <> Known domains: {domains.map((d) => <span className="chip" key={d}>{d}</span>)}</> : null}
          </div>
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">People<span className="count-pill">{users.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>User</th><th>Domains</th><th>Role</th><th>Status</th><th>Tenant Admin</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.id}</strong><div className="muted" style={{ fontSize: 11 }}>{u.name}</div></td>
                  <td>{u.domains.map((d) => <span className="chip" key={d}>{d}</span>)}</td>
                  <td>{u.role}</td>
                  <td><span className={`badge ${STATUS_BADGE[u.status]}`}>{u.status}</span></td>
                  <td>
                    <button
                      className={'switch' + (u.role === 'admin' ? ' on' : '')}
                      disabled={busy === u.id}
                      onClick={() => patch(u, { op: 'tenant-admin', isAdmin: u.role !== 'admin' })}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{u.role === 'admin' ? 'ON' : 'OFF'}</span>
                    </button>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {u.active ? (
                      <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === u.id} onClick={() => patch(u, { op: 'deactivate' })}>Deactivate</button>
                    ) : (
                      <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === u.id} onClick={() => patch(u, { op: 'reactivate' })}>Reactivate</button>
                    )}
                    <button className="btn ghost" style={{ padding: '4px 10px', marginLeft: 6 }} disabled={busy === u.id} onClick={() => offboard(u)}>Offboard</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
