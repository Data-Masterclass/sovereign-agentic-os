/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useUser } from '@/lib/useUser';
import type { Role } from '@/lib/session';

type PublicUser = { id: string; name: string; domains: string[]; role: Role };
const ROLES: Role[] = ['participant', 'creator', 'builder', 'admin'];

export default function UsersPage() {
  const { user, isAdmin, loading: meLoading } = useUser();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // create form
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('participant');
  const [domainText, setDomainText] = useState('');

  // master recovery key
  const [recoveryConfigured, setRecoveryConfigured] = useState<boolean | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');

  const loadRecovery = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/recovery', { cache: 'no-store' });
      if (res.ok) setRecoveryConfigured(Boolean((await res.json()).configured));
    } catch {
      /* ignore */
    }
  }, []);

  const generateRecovery = useCallback(async () => {
    setBusy('recovery');
    setError('');
    try {
      const res = await fetch('/api/auth/recovery', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Could not generate a recovery key');
        return;
      }
      setRecoveryKey(body.key);
      setRecoveryConfigured(true);
      // Download the recovery file exactly once.
      const blob = new Blob([body.file], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = body.filename ?? 'sovereign-os-recovery-key.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy('');
    }
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else {
        setUsers(body.users ?? []);
        setDomains(body.domains ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      load();
      loadRecovery();
    }
  }, [isAdmin, load, loadRecovery]);

  const create = useCallback(async () => {
    if (!id.trim() || !password.trim() || !domainText.trim()) return;
    setBusy('create');
    setError('');
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id, name, password, role,
          domains: domainText.split(',').map((d) => d.trim()).filter(Boolean),
        }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Create failed');
      else {
        setId(''); setName(''); setPassword(''); setDomainText(''); setRole('participant');
        await load();
      }
    } finally {
      setBusy('');
    }
  }, [id, name, password, role, domainText, load]);

  const changeRole = useCallback(async (u: PublicUser, newRole: Role) => {
    setBusy(u.id);
    try {
      await fetch(`/api/users/${u.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  const remove = useCallback(async (u: PublicUser) => {
    setBusy(u.id);
    try {
      const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? 'Delete failed');
      } else await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  if (meLoading) {
    return (<><PageHeader title="Users" crumb="platform · identity & domains" /><div className="content"><div className="stub-page">Loading…</div></div></>);
  }
  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Users" crumb="platform · identity & domains" />
        <div className="content">
          <div className="stub-page">
            This is a Platform-Admin surface. You are signed in as a {user?.role ?? 'guest'} — ask a
            domain admin to manage users.
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Users" crumb="platform · identity & domains" />
      <div className="content">
        <p className="lead">
          Create and manage participants. Each user belongs to one or more <strong>domains</strong>
          {' '}and has a <strong>role</strong>: a <em>participant</em> authors Personal artifacts, a{' '}
          <em>builder</em> can also promote to Shared, and an <em>admin</em> can certify to the
          Marketplace and manage users. Seeded/credential store now — replaceable by Ory later.
        </p>

        <div className="section-title">Account recovery</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <p style={{ marginTop: 0 }}>
            Generate a <strong>master recovery key</strong> and store it offline. If an admin is ever
            locked out, the key resets any account&apos;s password on the{' '}
            <a href="/recover">recovery page</a>. The server keeps only a hash — the key is shown and
            downloaded <strong>once</strong>. Lose it and it cannot be recovered.
          </p>
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" onClick={generateRecovery} disabled={busy === 'recovery'}>
              {busy === 'recovery' ? <span className="spin" /> : recoveryConfigured ? 'Rotate recovery key' : 'Generate recovery key'}
            </button>
            {recoveryConfigured === true && !recoveryKey ? (
              <span className="chip">A recovery key is configured</span>
            ) : null}
            {recoveryConfigured === false ? (
              <span className="chip" style={{ color: 'var(--warn, #b45309)' }}>No recovery key yet</span>
            ) : null}
          </div>
          {recoveryKey ? (
            <div className="card" style={{ marginTop: 12, background: 'var(--surface-2, #f6f6f7)' }}>
              <div className="hint" style={{ marginTop: 0 }}>
                Your master recovery key (downloaded as a file — this is the only time it is shown):
              </div>
              <code style={{ display: 'block', fontSize: 15, letterSpacing: 1, marginTop: 6, wordBreak: 'break-all' }}>
                {recoveryKey}
              </code>
              <div className="hint" style={{ fontSize: 11 }}>
                Store it offline (password manager / printed in a safe). Anyone with this key can regain admin access.
              </div>
            </div>
          ) : null}
        </div>

        <div className="section-title">Create user</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <input style={{ flex: '1 1 140px' }} value={id} onChange={(e) => setId(e.target.value)} placeholder="username (login)" />
            <input style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="full name" />
            <input style={{ flex: '1 1 140px' }} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" />
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
            <input style={{ flex: '1 1 220px' }} value={domainText} onChange={(e) => setDomainText(e.target.value)} placeholder="domains, comma-separated (e.g. sales, finance)" />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="btn" onClick={create} disabled={busy === 'create' || !id.trim() || !password.trim() || !domainText.trim()}>
              {busy === 'create' ? <span className="spin" /> : 'Create user'}
            </button>
          </div>
          {domains.length ? (
            <div className="hint" style={{ marginTop: 8 }}>Known domains: {domains.map((d) => <span className="chip" key={d}>{d}</span>)}</div>
          ) : null}
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">All users<span className="count-pill">{users.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>User</th><th>Domains</th><th>Role</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.id}</strong><div className="muted" style={{ fontSize: 11 }}>{u.name}</div></td>
                  <td>{u.domains.map((d) => <span className="chip" key={d}>{d}</span>)}</td>
                  <td>
                    <select value={u.role} disabled={busy === u.id || u.id === user?.id} onChange={(e) => changeRole(u, e.target.value as Role)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {u.id !== user?.id ? (
                      <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={busy === u.id} onClick={() => remove(u)}>Delete</button>
                    ) : <span className="muted" style={{ fontSize: 11 }}>you</span>}
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
