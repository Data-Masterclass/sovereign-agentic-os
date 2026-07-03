/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type GovUser = {
  id: string;
  name: string;
  email?: string;
  domains: string[];
  role: string;
  roleLabel: string;
  disabled?: boolean;
};

type RoleOption = { value: string; label: string };

type UsersData = {
  users: GovUser[];
  domains: string[];
  roles: RoleOption[];
  assignableRoles: RoleOption[];
};

// Role descriptions shown beneath the role selector.
const ROLE_DESC: Record<string, string> = {
  creator: 'Create and run your own data, agents and apps; use shared resources. Cannot publish to shared or approve.',
  builder: 'Creator rights plus review/approve, publish to shared, and manage your domain\'s members and deploys.',
  admin: 'Full control across all domains: users, policy, certification, cost caps.',
};

// ---------------------------------------------------------------------------
// Confirm dialog — no typed-phrase (that's for guarded platform ops).
// ---------------------------------------------------------------------------
function ConfirmDialog({
  open, title, body, confirmLabel, danger, busy, onConfirm, onCancel,
}: {
  open: boolean; title: string; body: string; confirmLabel: string;
  danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        style={{ background: 'var(--surface, #fff)', borderRadius: 14, padding: '28px 32px', width: 380, boxShadow: '0 12px 48px rgba(0,0,0,0.22)', border: '1px solid var(--border, #e5e7eb)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 8 }}>{title}</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 22 }}>{body}</div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            style={danger ? { background: 'var(--danger, #dc2626)', borderColor: 'var(--danger, #dc2626)', color: '#fff' } : undefined}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spin" /> : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Domain multi-select (pill checkboxes).
// ---------------------------------------------------------------------------
function DomainPicker({
  available, selected, onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(d: string) {
    onChange(selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d]);
  }
  if (!available.length) return <div className="hint">No domains configured yet.</div>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {available.map((d) => {
        const on = selected.includes(d);
        return (
          <button
            key={d}
            type="button"
            onClick={() => toggle(d)}
            style={{
              padding: '4px 12px',
              borderRadius: 20,
              border: `1.5px solid ${on ? 'var(--accent, #2563eb)' : 'var(--border, #d1d5db)'}`,
              background: on ? 'var(--accent, #2563eb)' : 'transparent',
              color: on ? '#fff' : 'inherit',
              fontSize: 12,
              cursor: 'pointer',
              transition: 'all 0.12s',
            }}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role selector with inline description.
// ---------------------------------------------------------------------------
function RoleSelect({
  options, value, onChange, style,
}: {
  options: RoleOption[];
  value: string;
  onChange: (v: string) => void;
  style?: React.CSSProperties;
}) {
  const desc = ROLE_DESC[value];
  return (
    <div style={style}>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }}>
        {options.map((r) => (
          <option key={r.value} value={r.value}>{r.label}</option>
        ))}
      </select>
      {desc && <div className="hint" style={{ marginTop: 4, fontSize: 11 }}>{desc}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit user panel.
// ---------------------------------------------------------------------------
function EditUserPanel({
  open, user, assignable, allDomains, busy, error, onSave, onCancel,
}: {
  open: boolean;
  user: GovUser | null;
  assignable: RoleOption[];
  allDomains: string[];
  busy: boolean;
  error: string;
  onSave: (patch: { name: string; email: string; role: string; domains: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
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

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        style={{ background: 'var(--surface, #fff)', borderRadius: 14, padding: '28px 32px', width: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(0,0,0,0.22)', border: '1px solid var(--border, #e5e7eb)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 4 }}>
          Edit user
        </div>
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
            <div className="hint" style={{ marginBottom: 6 }}>Role</div>
            <RoleSelect options={assignable} value={role} onChange={setRole} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 6 }}>Domains</div>
            <DomainPicker available={allDomains} selected={domains} onChange={setDomains} />
            {domains.length === 0 && <div className="hint" style={{ marginTop: 4, color: 'var(--danger)' }}>Select at least one domain</div>}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            disabled={busy || !name.trim() || !domains.length}
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
// Main component
// ---------------------------------------------------------------------------
export default function UsersAccess() {
  const [data, setData] = useState<UsersData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // invite form
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newDomains, setNewDomains] = useState<string[]>([]);
  const [newRole, setNewRole] = useState('');

  // edit dialog
  const [editUser, setEditUser] = useState<GovUser | null>(null);
  const [editError, setEditError] = useState('');

  // archive confirm
  const [archiveTarget, setArchiveTarget] = useState<GovUser | null>(null);

  // permanent-delete confirm
  const [deleteTarget, setDeleteTarget] = useState<GovUser | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/governance/users', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load users');
      else {
        setData(body as UsersData);
        if (body.assignableRoles?.length) {
          setNewRole((prev) => prev || (body.assignableRoles[0].value as string));
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const invite = useCallback(async () => {
    const email = newEmail.trim();
    if (!email || !newDomains.length || !newRole) return;
    setBusy('invite');
    setError('');
    try {
      const res = await fetch('/api/governance/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Email is the login id — pass as both id and email.
        body: JSON.stringify({
          id: email,
          email,
          ...(newName.trim() ? { name: newName.trim() } : {}),
          domains: newDomains,
          role: newRole,
        }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Invite failed');
      else { setNewEmail(''); setNewName(''); setNewDomains([]); await load(); }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [newEmail, newName, newDomains, newRole, load]);

  const saveEdit = useCallback(async (patch: { name: string; email: string; role: string; domains: string[] }) => {
    if (!editUser) return;
    setBusy('edit');
    setEditError('');
    try {
      const res = await fetch('/api/governance/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: editUser.id, ...patch }),
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

  const confirmArchive = useCallback(async () => {
    if (!archiveTarget) return;
    setBusy(`archive:${archiveTarget.id}`);
    setError('');
    try {
      const res = await fetch('/api/governance/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: archiveTarget.id, deactivate: true }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Archive failed');
      else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      setArchiveTarget(null);
    }
  }, [archiveTarget, load]);

  const restore = useCallback(async (u: GovUser) => {
    setBusy(`restore:${u.id}`);
    setError('');
    try {
      const res = await fetch('/api/governance/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: u.id, restore: true }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Restore failed');
      else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [load]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setBusy(`delete:${deleteTarget.id}`);
    setError('');
    try {
      const res = await fetch('/api/governance/users', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Delete failed');
      else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      setDeleteTarget(null);
    }
  }, [deleteTarget, load]);

  const assignable = data?.assignableRoles ?? data?.roles ?? [];
  const allDomains = data?.domains ?? [];
  const activeUsers = data?.users.filter((u) => !u.disabled) ?? [];
  const archivedUsers = data?.users.filter((u) => u.disabled) ?? [];

  return (
    <div>
      {/* Dialogs */}
      <EditUserPanel
        open={!!editUser}
        user={editUser}
        assignable={assignable}
        allDomains={allDomains}
        busy={busy === 'edit'}
        error={editError}
        onSave={saveEdit}
        onCancel={() => { setEditUser(null); setEditError(''); }}
      />
      <ConfirmDialog
        open={!!archiveTarget}
        title={`Archive ${archiveTarget?.name || archiveTarget?.id}?`}
        body={`${archiveTarget?.id} will no longer be able to sign in. You can restore them at any time from the Archived section below.`}
        confirmLabel="Archive"
        busy={busy === `archive:${archiveTarget?.id}`}
        onConfirm={confirmArchive}
        onCancel={() => setArchiveTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        title={`Permanently delete ${deleteTarget?.name || deleteTarget?.id}?`}
        body={`This will permanently remove ${deleteTarget?.id} from the platform. This cannot be undone.`}
        confirmLabel="Delete permanently"
        danger
        busy={busy === `delete:${deleteTarget?.id}`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <div className="section-title">
        Users &amp; access
        {data && <span className="count-pill">{activeUsers.length}</span>}
        <button className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 12px' }} onClick={load}>
          Refresh
        </button>
      </div>
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Accounts &amp; passwords are handled by the identity provider — no credentials are set or stored here.
      </p>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {!data && !error && <div className="stub-page">Loading users…</div>}

      {data && (
        <>
          {/* Invite form */}
          <div className="section-title">Invite user</div>
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <input
                type="email"
                style={{ flex: '1 1 200px', padding: '8px 12px' }}
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="email address (becomes login)"
              />
              <input
                type="text"
                style={{ flex: '1 1 160px', padding: '8px 12px' }}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="full name (optional)"
              />
            </div>

            <div className="hint" style={{ marginBottom: 6 }}>Domains</div>
            <DomainPicker available={allDomains} selected={newDomains} onChange={setNewDomains} />

            <div style={{ marginTop: 12 }}>
              <div className="hint" style={{ marginBottom: 6 }}>Role</div>
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <RoleSelect
                  options={assignable}
                  value={newRole}
                  onChange={setNewRole}
                  style={{ flex: '1 1 180px' }}
                />
                <button
                  className="btn"
                  style={{ flexShrink: 0 }}
                  disabled={busy === 'invite' || !newEmail.trim() || !newDomains.length || !newRole}
                  onClick={invite}
                >
                  {busy === 'invite' ? <span className="spin" /> : 'Invite'}
                </button>
              </div>
            </div>
          </div>

          {/* Active users table */}
          <div className="section-title">Active users</div>
          {activeUsers.length === 0 ? (
            <div className="stub-page">No active users.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>User</th><th>Domains</th><th>Role</th><th></th></tr>
                </thead>
                <tbody>
                  {activeUsers.map((u) => {
                    const isBusy = busy.includes(`:${u.id}`);
                    return (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.id}</strong>
                          {u.name && u.name !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.name}</div>}
                          {u.email && u.email !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.email}</div>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {u.domains.map((d) => <span className="chip" key={d}>{d}</span>)}
                          </div>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <span className="chip">{u.roleLabel || u.role}</span>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn ghost"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              disabled={isBusy}
                              onClick={() => { setEditError(''); setEditUser(u); }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn ghost"
                              style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)', borderColor: 'rgba(229,104,95,0.35)' }}
                              disabled={isBusy}
                              onClick={() => setArchiveTarget(u)}
                            >
                              {busy === `archive:${u.id}` ? <span className="spin" /> : 'Archive'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Archived users */}
          {archivedUsers.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 36, opacity: 0.7 }}>
                Archived
                <span className="count-pill">{archivedUsers.length}</span>
              </div>
              <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
                Archived users cannot sign in. Restore to re-enable, or permanently delete to remove entirely.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>User</th><th>Domains</th><th>Role</th><th></th></tr>
                  </thead>
                  <tbody>
                    {archivedUsers.map((u) => (
                      <tr key={u.id} style={{ opacity: 0.65 }}>
                        <td>
                          <strong>{u.id}</strong>
                          {u.name && u.name !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.name}</div>}
                          {u.email && u.email !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.email}</div>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {u.domains.map((d) => <span className="chip" key={d}>{d}</span>)}
                          </div>
                        </td>
                        <td><span className="chip">{u.roleLabel || u.role}</span></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn ghost"
                              style={{ padding: '4px 10px', fontSize: 12 }}
                              disabled={!!busy}
                              onClick={() => restore(u)}
                            >
                              {busy === `restore:${u.id}` ? <span className="spin" /> : 'Restore'}
                            </button>
                            <button
                              className="btn ghost"
                              style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)', borderColor: 'rgba(229,104,95,0.35)' }}
                              disabled={!!busy}
                              onClick={() => setDeleteTarget(u)}
                            >
                              Delete permanently
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
