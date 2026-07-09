/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type Role = 'creator' | 'builder' | 'domain_admin' | 'admin';
type Status = 'active' | 'invited' | 'deactivated';
type AccessUser = {
  id: string;
  name: string;
  email?: string;
  domains: string[];
  role: Role;
  status: Status;
  active: boolean;
};
type Sso = { enabled: boolean; provider: string; issuerUrl: string; scim: boolean };
const ROLES: Role[] = ['creator', 'builder', 'domain_admin', 'admin'];
const STATUS_BADGE: Record<Status, string> = { active: 'ok', invited: 'muted', deactivated: 'err' };

// ---------------------------------------------------------------------------
// Inline edit panel (modal overlay)
// ---------------------------------------------------------------------------
function EditUserPanel({
  open,
  user,
  allDomains,
  busy,
  error,
  onSave,
  onCancel,
}: {
  open: boolean;
  user: AccessUser | null;
  allDomains: string[];
  busy: boolean;
  error: string;
  onSave: (patch: { name: string; email: string; role: Role; domains: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('creator');
  const [domains, setDomains] = useState<string[]>([]);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user && open) {
      setName(user.name ?? '');
      setEmail(user.email ?? '');
      setRole(user.role);
      setDomains(user.domains);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [user, open]);

  if (!open || !user) return null;

  function toggleDomain(d: string) {
    setDomains((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        style={{ background: 'var(--surface, #fff)', borderRadius: 14, padding: '28px 32px', width: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(0,0,0,0.22)', border: '1px solid var(--border, #e5e7eb)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 4 }}>Edit user</div>
        <div className="hint" style={{ marginBottom: 16, fontSize: 12 }}>
          <strong>{user.id}</strong> — username and password are managed by the identity provider.
        </div>

        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="hint" style={{ marginBottom: 4 }}>Full name</div>
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} placeholder="Full name" />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 4 }}>Email</div>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} placeholder="user@example.com" />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 4 }}>Role</div>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ width: '100%' }}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {allDomains.length > 0 && (
            <div>
              <div className="hint" style={{ marginBottom: 6 }}>Domains</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {allDomains.map((d) => {
                  const on = domains.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDomain(d)}
                      style={{
                        padding: '4px 12px',
                        borderRadius: 20,
                        border: `1.5px solid ${on ? 'var(--accent, #2563eb)' : 'var(--border, #d1d5db)'}`,
                        background: on ? 'var(--accent, #2563eb)' : 'transparent',
                        color: on ? '#fff' : 'inherit',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              {domains.length === 0 && <div className="hint" style={{ marginTop: 4, color: 'var(--danger)' }}>Select at least one domain</div>}
            </div>
          )}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            disabled={busy || !name.trim() || domains.length === 0}
            onClick={() => onSave({ name: name.trim(), email: email.trim(), role, domains })}
          >
            {busy ? <span className="spin" /> : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function AccessPage() {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [sso, setSso] = useState<Sso | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // invite form
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('creator');
  const [domainText, setDomainText] = useState('');

  // edit dialog
  const [editUser, setEditUser] = useState<AccessUser | null>(null);
  const [editError, setEditError] = useState('');

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
      else { setId(''); setName(''); setDomainText(''); setRole('creator'); await load(); }
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

  const saveEdit = useCallback(async (p: { name: string; email: string; role: Role; domains: string[] }) => {
    if (!editUser) return;
    setBusy(`edit:${editUser.id}`);
    setEditError('');
    try {
      const res = await fetch(`/api/platform-admin/access/${editUser.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'edit', ...p }),
      });
      const body = await res.json();
      if (!res.ok) { setEditError(body.error ?? 'Save failed'); return; }
      setEditUser(null);
      await load();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [editUser, load]);

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
      <EditUserPanel
        open={!!editUser}
        user={editUser}
        allDomains={domains}
        busy={busy.startsWith('edit:')}
        error={editError}
        onSave={saveEdit}
        onCancel={() => { setEditUser(null); setEditError(''); }}
      />

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
                  <td>
                    <strong>{u.id}</strong>
                    <div className="muted" style={{ fontSize: 11 }}>{u.name}</div>
                    {u.email && u.email !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.email}</div>}
                  </td>
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
                    <button
                      className="btn ghost"
                      style={{ padding: '4px 10px' }}
                      disabled={!!busy}
                      onClick={() => { setEditError(''); setEditUser(u); }}
                    >
                      Edit
                    </button>
                    {u.active ? (
                      <button className="btn ghost" style={{ padding: '4px 10px', marginLeft: 6 }} disabled={busy === u.id} onClick={() => patch(u, { op: 'deactivate' })}>Deactivate</button>
                    ) : (
                      <button className="btn ghost" style={{ padding: '4px 10px', marginLeft: 6 }} disabled={busy === u.id} onClick={() => patch(u, { op: 'reactivate' })}>Reactivate</button>
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
