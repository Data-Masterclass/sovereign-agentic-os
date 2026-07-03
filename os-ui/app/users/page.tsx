/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useUser } from '@/lib/useUser';
import type { Role } from '@/lib/session';

type PublicUser = {
  id: string;
  name: string;
  email?: string;
  domains: string[];
  role: Role;
  disabled?: boolean;
};

const ROLES: Role[] = ['creator', 'builder', 'admin'];

const ROLE_DESC: Record<Role, string> = {
  creator: 'Create and run your own data, agents and apps; use shared resources. Cannot publish to shared or approve.',
  builder: "Creator rights plus review/approve, publish to shared, and manage your domain's members and deploys.",
  admin: 'Full control across all domains: users, policy, certification, cost caps.',
};

// ---------------------------------------------------------------------------
// Confirm dialog
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
// Domain pill picker
// ---------------------------------------------------------------------------
function DomainPicker({ available, selected, onChange }: { available: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  if (!available.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {available.map((d) => {
        const on = selected.includes(d);
        return (
          <button key={d} type="button"
            onClick={() => onChange(on ? selected.filter((x) => x !== d) : [...selected, d])}
            style={{ padding: '4px 12px', borderRadius: 20, border: `1.5px solid ${on ? 'var(--accent,#2563eb)' : 'var(--border,#d1d5db)'}`, background: on ? 'var(--accent,#2563eb)' : 'transparent', color: on ? '#fff' : 'inherit', fontSize: 12, cursor: 'pointer', transition: 'all 0.12s' }}
          >{d}</button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit user panel
// ---------------------------------------------------------------------------
function EditUserPanel({ open, user, allDomains, busy, error, onSave, onCancel }: {
  open: boolean; user: PublicUser | null; allDomains: string[]; busy: boolean; error: string;
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
      setName(user.name ?? ''); setEmail(user.email ?? ''); setRole(user.role); setDomains(user.domains);
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [user, open]);

  if (!open || !user) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onCancel}>
      <div style={{ background: 'var(--surface,#fff)', borderRadius: 14, padding: '28px 32px', width: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(0,0,0,0.22)', border: '1px solid var(--border,#e5e7eb)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 4 }}>Edit user</div>
        <div className="hint" style={{ marginBottom: 16, fontSize: 12 }}><strong>{user.id}</strong> — username and password are managed by the identity provider.</div>
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
              {ROLES.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
            </select>
            {ROLE_DESC[role] && <div className="hint" style={{ marginTop: 4, fontSize: 11 }}>{ROLE_DESC[role]}</div>}
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 6 }}>Domains</div>
            <DomainPicker available={allDomains} selected={domains} onChange={setDomains} />
            {!domains.length && <div className="hint" style={{ marginTop: 4, color: 'var(--danger)' }}>Select at least one domain</div>}
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn" disabled={busy || !name.trim() || !domains.length} onClick={() => onSave({ name: name.trim(), email: email.trim(), role, domains })}>
            {busy ? <span className="spin" /> : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function UsersPage() {
  const { user, isAdmin, loading: meLoading } = useUser();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('creator');
  const [newDomains, setNewDomains] = useState<string[]>([]);

  const [editUser, setEditUser] = useState<PublicUser | null>(null);
  const [editError, setEditError] = useState('');
  const [archiveTarget, setArchiveTarget] = useState<PublicUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublicUser | null>(null);

  const [recoveryConfigured, setRecoveryConfigured] = useState<boolean | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');

  const loadRecovery = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/recovery', { cache: 'no-store' });
      if (res.ok) setRecoveryConfigured(Boolean((await res.json()).configured));
    } catch { /* ignore */ }
  }, []);

  const generateRecovery = useCallback(async () => {
    setBusy('recovery'); setError('');
    try {
      const res = await fetch('/api/auth/recovery', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? 'Could not generate a recovery key'); return; }
      setRecoveryKey(body.key); setRecoveryConfigured(true);
      const blob = new Blob([body.file], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = body.filename ?? 'sovereign-os-recovery-key.txt';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } finally { setBusy(''); }
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else { setUsers(body.users ?? []); setDomains(body.domains ?? []); }
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { if (isAdmin) { load(); loadRecovery(); } }, [isAdmin, load, loadRecovery]);

  const create = useCallback(async () => {
    const email = newEmail.trim();
    if (!email || !newPassword.trim() || !newDomains.length) return;
    setBusy('create'); setError('');
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: email, email, name: newName || undefined, password: newPassword, role: newRole, domains: newDomains }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Create failed');
      else { setNewEmail(''); setNewName(''); setNewPassword(''); setNewDomains([]); setNewRole('creator'); await load(); }
    } finally { setBusy(''); }
  }, [newEmail, newName, newPassword, newRole, newDomains, load]);

  const saveEdit = useCallback(async (patch: { name: string; email: string; role: Role; domains: string[] }) => {
    if (!editUser) return;
    setBusy('edit'); setEditError('');
    try {
      const res = await fetch(`/api/users/${editUser.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const body = await res.json();
      if (!res.ok) { setEditError(body.error ?? 'Save failed'); return; }
      setEditUser(null); await load();
    } catch (e) { setEditError((e as Error).message); }
    finally { setBusy(''); }
  }, [editUser, load]);

  const confirmArchive = useCallback(async () => {
    if (!archiveTarget) return;
    setBusy(`archive:${archiveTarget.id}`); setError('');
    try {
      const res = await fetch(`/api/users/${archiveTarget.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archive: true }) });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Archive failed');
      else await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); setArchiveTarget(null); }
  }, [archiveTarget, load]);

  const restore = useCallback(async (u: PublicUser) => {
    setBusy(`restore:${u.id}`); setError('');
    try {
      const res = await fetch(`/api/users/${u.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ restore: true }) });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Restore failed'); else await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }, [load]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setBusy(`delete:${deleteTarget.id}`); setError('');
    try {
      const res = await fetch(`/api/users/${deleteTarget.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? 'Delete failed'); else await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); setDeleteTarget(null); }
  }, [deleteTarget, load]);

  if (meLoading) return (<><PageHeader title="Users" crumb="platform · identity & domains" /><div className="content"><div className="stub-page">Loading…</div></div></>);
  if (!isAdmin) return (
    <><PageHeader title="Users" crumb="platform · identity & domains" />
      <div className="content"><div className="stub-page">Platform-Admin surface. You are signed in as a {user?.role ?? 'guest'} — ask an admin to manage users.</div></div></>
  );

  const activeUsers = users.filter((u) => !u.disabled);
  const archivedUsers = users.filter((u) => u.disabled);

  return (
    <>
      <PageHeader title="Users" crumb="platform · identity & domains" />
      <EditUserPanel open={!!editUser} user={editUser} allDomains={domains} busy={busy === 'edit'} error={editError} onSave={saveEdit} onCancel={() => { setEditUser(null); setEditError(''); }} />
      <ConfirmDialog open={!!archiveTarget} title={`Archive ${archiveTarget?.name || archiveTarget?.id}?`} body={`${archiveTarget?.id} will no longer be able to sign in. You can restore them at any time.`} confirmLabel="Archive" busy={busy === `archive:${archiveTarget?.id}`} onConfirm={confirmArchive} onCancel={() => setArchiveTarget(null)} />
      <ConfirmDialog open={!!deleteTarget} title={`Permanently delete ${deleteTarget?.name || deleteTarget?.id}?`} body={`This will permanently remove ${deleteTarget?.id} from the platform. This cannot be undone.`} confirmLabel="Delete permanently" danger busy={busy === `delete:${deleteTarget?.id}`} onConfirm={confirmDelete} onCancel={() => setDeleteTarget(null)} />

      <div className="content">
        <p className="lead">Create and manage members. Each user belongs to one or more <strong>domains</strong> and has a <strong>role</strong>.</p>

        <div className="section-title">Account recovery</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <p style={{ marginTop: 0 }}>Generate a <strong>master recovery key</strong> and store it offline. The server keeps only a hash — shown and downloaded <strong>once</strong>.</p>
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn" onClick={generateRecovery} disabled={busy === 'recovery'}>{busy === 'recovery' ? <span className="spin" /> : recoveryConfigured ? 'Rotate recovery key' : 'Generate recovery key'}</button>
            {recoveryConfigured === true && !recoveryKey && <span className="chip">A recovery key is configured</span>}
            {recoveryConfigured === false && <span className="chip" style={{ color: 'var(--warn,#b45309)' }}>No recovery key yet</span>}
          </div>
          {recoveryKey && (
            <div className="card" style={{ marginTop: 12, background: 'var(--surface-2,#f6f6f7)' }}>
              <div className="hint" style={{ marginTop: 0 }}>Your master recovery key (downloaded — only shown once):</div>
              <code style={{ display: 'block', fontSize: 15, letterSpacing: 1, marginTop: 6, wordBreak: 'break-all' }}>{recoveryKey}</code>
            </div>
          )}
        </div>

        <div className="section-title">Create user</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
            <input type="email" style={{ flex: '1 1 200px' }} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="email address (becomes login)" />
            <input style={{ flex: '1 1 160px' }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="full name (optional)" />
            <input style={{ flex: '1 1 140px' }} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="initial password" />
          </div>
          <div className="hint" style={{ marginBottom: 6 }}>Domains</div>
          <DomainPicker available={domains} selected={newDomains} onChange={setNewDomains} />
          <div style={{ marginTop: 12 }}>
            <div className="hint" style={{ marginBottom: 4 }}>Role</div>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px' }}>
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)} style={{ width: '100%' }}>
                  {ROLES.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                </select>
                {ROLE_DESC[newRole] && <div className="hint" style={{ marginTop: 4, fontSize: 11 }}>{ROLE_DESC[newRole]}</div>}
              </div>
              <button className="btn" style={{ flexShrink: 0 }} onClick={create} disabled={busy === 'create' || !newEmail.trim() || !newPassword.trim() || !newDomains.length}>
                {busy === 'create' ? <span className="spin" /> : 'Create user'}
              </button>
            </div>
          </div>
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Active users<span className="count-pill">{activeUsers.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>User</th><th>Domains</th><th>Role</th><th></th></tr></thead>
            <tbody>
              {activeUsers.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.id}</strong>
                    {u.name && u.name !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.name}</div>}
                    {u.email && u.email !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.email}</div>}
                  </td>
                  <td>{u.domains.map((d) => <span className="chip" key={d}>{d}</span>)}</td>
                  <td><span style={{ fontSize: 12 }}>{u.role}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    {u.id !== user?.id ? (
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!!busy} onClick={() => { setEditError(''); setEditUser(u); }}>Edit</button>
                        <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)', borderColor: 'rgba(229,104,95,0.35)' }} disabled={!!busy} onClick={() => setArchiveTarget(u)}>Archive</button>
                      </div>
                    ) : <span className="muted" style={{ fontSize: 11 }}>you</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {archivedUsers.length > 0 && (
          <>
            <div className="section-title" style={{ marginTop: 36, opacity: 0.7 }}>Archived<span className="count-pill">{archivedUsers.length}</span></div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>Archived users cannot sign in. Restore to re-enable, or permanently delete to remove.</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>User</th><th>Domains</th><th>Role</th><th></th></tr></thead>
                <tbody>
                  {archivedUsers.map((u) => (
                    <tr key={u.id} style={{ opacity: 0.65 }}>
                      <td><strong>{u.id}</strong>{u.name && u.name !== u.id && <div className="muted" style={{ fontSize: 11 }}>{u.name}</div>}</td>
                      <td>{u.domains.map((d) => <span className="chip" key={d}>{d}</span>)}</td>
                      <td><span style={{ fontSize: 12 }}>{u.role}</span></td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!!busy} onClick={() => restore(u)}>{busy === `restore:${u.id}` ? <span className="spin" /> : 'Restore'}</button>
                          <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)', borderColor: 'rgba(229,104,95,0.35)' }} disabled={!!busy} onClick={() => setDeleteTarget(u)}>Delete permanently</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
