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
  builder: 'Creator rights plus review/approve, publish to shared, and approve deploys in your domain. Not a people-admin.',
  domain_admin: 'Builder rights plus administer users in your own domain(s): invite, edit, deactivate, assign roles up to Builder. Only an Admin appoints this role.',
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
// Password field — shared by the invite form and the reset dialog.
// ---------------------------------------------------------------------------
type StrengthResult = { ok: boolean; score: number; reasons: string[] };

function assessClient(pw: string, username = ''): StrengthResult {
  const reasons: string[] = [];
  const lower = pw.toLowerCase();
  if (pw.length < 12) reasons.push('Use at least 12 characters');
  const classes =
    Number(/[a-z]/.test(pw)) + Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) + Number(/[^A-Za-z0-9]/.test(pw));
  if (classes < 3) reasons.push('Mix upper, lower, numbers and symbols (3 of 4)');
  const common = new Set(['password','admin','changeme','letmein','welcome','qwerty','123456']);
  if (common.has(lower)) reasons.push('That password is too common');
  if (username && lower.includes(username.trim().toLowerCase()) && username.trim().length >= 3)
    reasons.push('Do not include the username');
  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  score += Math.max(0, classes - 2);
  score = Math.min(4, score);
  return { ok: reasons.length === 0, score, reasons };
}

const SCORE_COLOR = ['#dc2626','#f97316','#eab308','#22c55e','#16a34a'];
const SCORE_LABEL = ['Very weak','Weak','Fair','Strong','Very strong'];

function PasswordField({
  value, onChange, username, generateUrl,
}: {
  value: string;
  onChange: (v: string) => void;
  username?: string;
  generateUrl: string;
}) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const strength = assessClient(value, username);

  async function generate() {
    setGenerating(true);
    try {
      const res = await fetch(generateUrl);
      if (res.ok) {
        const data = await res.json() as { password?: string };
        if (data.password) onChange(data.password);
      }
    } catch { /* ignore */ } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Set a strong password"
            style={{ width: '100%', paddingRight: 80 }}
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--muted, #6b7280)', padding: '2px 4px' }}
            tabIndex={-1}
          >
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        <button type="button" className="btn ghost" style={{ padding: '6px 10px', fontSize: 12, flexShrink: 0 }} onClick={copy} disabled={!value}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn ghost" style={{ padding: '6px 10px', fontSize: 12, flexShrink: 0 }} onClick={generate} disabled={generating}>
          {generating ? <span className="spin" /> : 'Generate'}
        </button>
      </div>
      {value && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', gap: 3, marginBottom: 3 }}>
            {[0,1,2,3].map((i) => (
              <div key={i} style={{ height: 3, flex: 1, borderRadius: 2, background: i < strength.score ? SCORE_COLOR[strength.score] : 'var(--border, #e5e7eb)', transition: 'background 0.2s' }} />
            ))}
          </div>
          <div style={{ fontSize: 11, color: strength.ok ? SCORE_COLOR[strength.score] : 'var(--danger, #dc2626)' }}>
            {strength.ok ? SCORE_LABEL[strength.score] : strength.reasons[0]}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invite result — shows the password ONCE with a copy button.
// ---------------------------------------------------------------------------
function InviteResultDialog({
  open, userId, tempPassword, onClose,
}: {
  open: boolean; userId: string; tempPassword: string; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable — the value is shown for manual copy */ }
  }
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--surface, #fff)', borderRadius: 14, padding: '28px 32px', width: 440, boxShadow: '0 12px 48px rgba(0,0,0,0.22)', border: '1px solid var(--border, #e5e7eb)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 8 }}>User created</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
          <strong>{userId}</strong> can sign in with the password below. Share it with
          them — they&apos;ll be required to set their own password on first login. This is the
          only time it&apos;s shown.
        </div>
        <div
          style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--code-bg, #f4f4f5)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, padding: '10px 12px', marginBottom: 18 }}
        >
          <code style={{ flex: 1, fontSize: 15, letterSpacing: 0.5, wordBreak: 'break-all' }}>{tempPassword}</code>
          <button className="btn" style={{ padding: '4px 12px', fontSize: 12, flexShrink: 0 }} onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reset password dialog — admin sets/generates a new password for an existing user.
// ---------------------------------------------------------------------------
function ResetPasswordDialog({
  open, userId, busy, error, onReset, onCancel,
}: {
  open: boolean; userId: string; busy: boolean; error: string;
  onReset: (password: string) => void; onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const strength = assessClient(password, userId);
  useEffect(() => { if (!open) setPassword(''); }, [open]);
  if (!open) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        style={{ background: 'var(--surface, #fff)', borderRadius: 14, padding: '28px 32px', width: 460, boxShadow: '0 12px 48px rgba(0,0,0,0.22)', border: '1px solid var(--border, #e5e7eb)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 4 }}>Reset password</div>
        <div className="hint" style={{ marginBottom: 14, fontSize: 12 }}>
          Set a new password for <strong>{userId}</strong>. The password is shown once — share it with them directly. They will be required to set their own on next login.
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <PasswordField value={password} onChange={setPassword} username={userId} generateUrl="/api/users/gen-password" />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            disabled={busy || !password || !strength.ok}
            onClick={() => onReset(password)}
          >
            {busy ? <span className="spin" /> : 'Set password'}
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
  open, user, assignable, allDomains, busy, error, onSave, onCancel, onResetPassword,
}: {
  open: boolean;
  user: GovUser | null;
  assignable: RoleOption[];
  allDomains: string[];
  busy: boolean;
  error: string;
  onSave: (patch: { name: string; email: string; role: string; domains: string[] }) => void;
  onCancel: () => void;
  onResetPassword?: () => void;
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2 }}>Edit user</div>
          {onResetPassword && (
            <button
              type="button"
              className="btn ghost"
              style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 12 }}
              onClick={onResetPassword}
              disabled={busy}
            >
              Reset password…
            </button>
          )}
        </div>
        <div className="hint" style={{ marginBottom: 16, fontSize: 12 }}>
          <strong>{user.id}</strong>
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
  const [newPassword, setNewPassword] = useState('');

  // edit dialog
  const [editUser, setEditUser] = useState<GovUser | null>(null);
  const [editError, setEditError] = useState('');

  // reset-password dialog
  const [resetTarget, setResetTarget] = useState<GovUser | null>(null);
  const [resetError, setResetError] = useState('');

  // invite result — the one-time password to hand to the invitee.
  const [invited, setInvited] = useState<{ id: string; tempPassword: string } | null>(null);

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
    const pw = newPassword.trim();
    if (!pw) { setError('A password is required — type one or click Generate'); return; }
    const strength = assessClient(pw, email);
    if (!strength.ok) { setError(strength.reasons[0] ?? 'Password is too weak'); return; }
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
          password: pw,
        }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Invite failed');
      else {
        // Surface the password to the admin exactly once — the server never returns it again.
        if (body.tempPassword) setInvited({ id: body.user?.id ?? email, tempPassword: body.tempPassword });
        setNewEmail(''); setNewName(''); setNewDomains([]); setNewPassword(''); await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [newEmail, newName, newDomains, newRole, newPassword, load]);

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

  const resetPassword = useCallback(async (password: string) => {
    if (!resetTarget) return;
    setBusy('reset');
    setResetError('');
    try {
      const res = await fetch('/api/governance/users', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: resetTarget.id, resetPassword: true, password }),
      });
      const body = await res.json();
      if (!res.ok) { setResetError(body.error ?? 'Reset failed'); return; }
      // Show the new password once so the admin can relay it.
      if (body.tempPassword) setInvited({ id: resetTarget.id, tempPassword: body.tempPassword });
      setResetTarget(null);
      setEditUser(null);
    } catch (e) {
      setResetError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [resetTarget]);

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
      <InviteResultDialog
        open={!!invited}
        userId={invited?.id ?? ''}
        tempPassword={invited?.tempPassword ?? ''}
        onClose={() => setInvited(null)}
      />
      <EditUserPanel
        open={!!editUser}
        user={editUser}
        assignable={assignable}
        allDomains={allDomains}
        busy={busy === 'edit'}
        error={editError}
        onSave={saveEdit}
        onCancel={() => { setEditUser(null); setEditError(''); }}
        onResetPassword={() => { setResetTarget(editUser); setResetError(''); }}
      />
      <ResetPasswordDialog
        open={!!resetTarget}
        userId={resetTarget?.id ?? ''}
        busy={busy === 'reset'}
        error={resetError}
        onReset={resetPassword}
        onCancel={() => { setResetTarget(null); setResetError(''); }}
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
        Set a strong password when creating a user — it is shown to you once so you can relay it.
        Users are required to change it on first login. Passwords are stored only as salted hashes.
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

            <div>
              <div className="hint" style={{ marginBottom: 6 }}>Password</div>
              <PasswordField value={newPassword} onChange={setNewPassword} username={newEmail.trim()} generateUrl="/api/users/gen-password" />
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
                  disabled={busy === 'invite' || !newEmail.trim() || !newDomains.length || !newRole || !assessClient(newPassword.trim(), newEmail.trim()).ok}
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
