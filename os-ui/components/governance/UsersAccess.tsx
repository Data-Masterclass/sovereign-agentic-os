/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type GovUser = {
  id: string;
  name: string;
  domains: string[];
  role: string;
  roleLabel: string;
};

type RoleOption = { value: string; label: string };

type UsersData = {
  users: GovUser[];
  domains: string[];
  roles: RoleOption[];
  assignableRoles: RoleOption[];
};

export default function UsersAccess() {
  const [data, setData] = useState<UsersData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // invite form
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDomains, setNewDomains] = useState('');
  const [newRole, setNewRole] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/governance/users', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load users');
      else {
        setData(body as UsersData);
        // initialise role only if not yet chosen
        if (body.assignableRoles?.length) {
          setNewRole((prev) => prev || (body.assignableRoles[0].value as string));
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const invite = useCallback(async () => {
    if (!newId.trim() || !newDomains.trim() || !newRole) return;
    setBusy('invite');
    setError('');
    try {
      const res = await fetch('/api/governance/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: newId.trim(),
          ...(newName.trim() ? { name: newName.trim() } : {}),
          domains: newDomains
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean),
          role: newRole,
        }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Invite failed');
      else {
        setNewId('');
        setNewName('');
        setNewDomains('');
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [newId, newName, newDomains, newRole, load]);

  const changeRole = useCallback(
    async (id: string, role: string) => {
      setBusy(`${id}:role`);
      setError('');
      try {
        const res = await fetch('/api/governance/users', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, role }),
        });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Role change failed');
        else await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const deactivate = useCallback(
    async (id: string) => {
      setBusy(`${id}:deactivate`);
      setError('');
      try {
        const res = await fetch('/api/governance/users', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, deactivate: true }),
        });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Deactivate failed');
        else await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [load],
  );

  const assignable = data?.assignableRoles ?? data?.roles ?? [];

  return (
    <div>
      <div className="section-title">
        Users & access
        {data && <span className="count-pill">{data.users.length}</span>}
        <button
          className="btn ghost"
          style={{ marginLeft: 'auto', padding: '4px 12px' }}
          onClick={load}
        >
          Refresh
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Accounts &amp; passwords are handled by Ory&rsquo;s secure flow — no credentials are
        set or stored here.
      </p>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      {!data && !error && <div className="stub-page">Loading users…</div>}

      {data && (
        <>
          {/* Invite form */}
          <div className="section-title">Invite user</div>
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <input
                type="text"
                style={{ flex: '1 1 130px', padding: '8px 12px' }}
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="user id (login)"
              />
              <input
                type="text"
                style={{ flex: '1 1 160px', padding: '8px 12px' }}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="full name (optional)"
              />
              <input
                type="text"
                style={{ flex: '1 1 180px', padding: '8px 12px' }}
                value={newDomains}
                onChange={(e) => setNewDomains(e.target.value)}
                placeholder="domains, comma-separated"
              />
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                style={{ minWidth: 130 }}
              >
                {assignable.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <button
                className="btn"
                disabled={
                  busy === 'invite' ||
                  !newId.trim() ||
                  !newDomains.trim() ||
                  !newRole
                }
                onClick={invite}
              >
                {busy === 'invite' ? <span className="spin" /> : 'Invite'}
              </button>
            </div>
            {data.domains.length > 0 && (
              <div className="hint" style={{ marginTop: 8 }}>
                Known domains:{' '}
                {data.domains.map((d) => (
                  <span className="chip" key={d} style={{ marginRight: 4 }}>{d}</span>
                ))}
              </div>
            )}
          </div>

          {/* Users table */}
          <div className="section-title">All users</div>
          {data.users.length === 0 ? (
            <div className="stub-page">No users yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Domains</th>
                    <th>Role</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u) => {
                    const isBusy = busy.startsWith(`${u.id}:`);
                    return (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.id}</strong>
                          {u.name && (
                            <div className="muted" style={{ fontSize: 11 }}>{u.name}</div>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {u.domains.map((d) => (
                              <span className="chip" key={d}>{d}</span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <select
                            value={u.role}
                            disabled={isBusy}
                            onChange={(e) => changeRole(u.id, e.target.value)}
                            style={{ minWidth: 120 }}
                          >
                            {assignable.map((r) => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </select>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn ghost"
                            style={{
                              padding: '4px 10px',
                              fontSize: 12,
                              color: 'var(--danger)',
                              borderColor: 'rgba(229,104,95,0.35)',
                            }}
                            disabled={isBusy}
                            onClick={() => deactivate(u.id)}
                          >
                            {busy === `${u.id}:deactivate` ? (
                              <span className="spin" />
                            ) : (
                              'Deactivate'
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
