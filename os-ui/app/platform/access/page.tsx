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
const STATUS_ORDER: Record<Status, number> = { active: 0, invited: 1, deactivated: 2 };

// ---------------------------------------------------------------------------
// Password strength (mirrors lib/core/password.assessPasswordStrength — the API
// re-checks server-side; this is live UI feedback only).
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
  const common = new Set(['password', 'admin', 'changeme', 'letmein', 'welcome', 'qwerty', '123456']);
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
const SCORE_COLOR = ['#dc2626', '#f97316', '#eab308', '#22c55e', '#16a34a'];
const SCORE_LABEL = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];

const OVERLAY: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' };
const PANEL: React.CSSProperties = { background: 'var(--surface, #fff)', borderRadius: 14, padding: '28px 32px', width: 460, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 48px rgba(0,0,0,0.22)', border: '1px solid var(--border, #e5e7eb)' };

// ---------------------------------------------------------------------------
// Password field — Show/Hide, Copy, Generate, live strength meter.
// ---------------------------------------------------------------------------
function PasswordField({
  value, onChange, username,
}: {
  value: string;
  onChange: (v: string) => void;
  username?: string;
}) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [generating, setGenerating] = useState(false);
  const strength = assessClient(value, username);

  async function generate() {
    setGenerating(true);
    try {
      const res = await fetch('/api/users/gen-password');
      if (res.ok) {
        const data = (await res.json()) as { password?: string };
        if (data.password) { onChange(data.password); setShow(true); }
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
            placeholder="Set a strong password (or Generate)"
            style={{ width: '100%', paddingRight: 60 }}
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
            {[0, 1, 2, 3].map((i) => (
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
// Domain dropdown with checkboxes — a closed control showing the selection that
// opens a checkbox list and closes on outside click.
// ---------------------------------------------------------------------------
function DomainDropdown({
  available, selected, onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!available.length) return <div className="hint">No domains configured yet.</div>;

  function toggle(d: string) {
    onChange(selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d]);
  }
  const label = selected.length === 0 ? 'Select domains…' : selected.join(', ');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ width: '100%', textAlign: 'left', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border, #d1d5db)', background: 'var(--surface, #fff)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected.length ? 'inherit' : 'var(--muted, #6b7280)' }}>{label}</span>
        <span style={{ fontSize: 10, color: 'var(--muted, #6b7280)' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 10, background: 'var(--surface, #fff)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.16)', maxHeight: 220, overflowY: 'auto', padding: 4 }}>
          {available.map((d) => {
            const on = selected.includes(d);
            return (
              <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, background: on ? 'var(--hover, rgba(37,99,235,0.06))' : 'transparent' }}>
                <input type="checkbox" checked={on} onChange={() => toggle(d)} style={{ margin: 0 }} />
                {d}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog (plain / danger).
// ---------------------------------------------------------------------------
function ConfirmDialog({
  open, title, body, confirmLabel, danger, busy, onConfirm, onCancel,
}: {
  open: boolean; title: string; body: React.ReactNode; confirmLabel: string;
  danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={{ ...PANEL, width: 400 }} onClick={(e) => e.stopPropagation()}>
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
// One-time password result — shown once with a copy button.
// ---------------------------------------------------------------------------
function PasswordResultDialog({
  open, userId, password, onClose,
}: {
  open: boolean; userId: string; password: string; onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* value is shown for manual copy */ }
  }
  return (
    <div style={OVERLAY} onClick={onClose}>
      <div style={{ ...PANEL, width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 8 }}>Password set</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
          <strong>{userId}</strong> can sign in with the password below. Share it with them
          directly — they&apos;ll be asked to set their own on first login. This is the only time it&apos;s shown.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--code-bg, #f4f4f5)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, padding: '10px 12px', marginBottom: 18 }}>
          <code style={{ flex: 1, fontSize: 15, letterSpacing: 0.5, wordBreak: 'break-all' }}>{password}</code>
          <button className="btn" style={{ padding: '4px 12px', fontSize: 12, flexShrink: 0 }} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offboard dialog — strong-danger, with reassign-vs-delete choice.
// ---------------------------------------------------------------------------
function OffboardDialog({
  open, user, others, busy, error, onConfirm, onCancel,
}: {
  open: boolean; user: AccessUser | null; others: AccessUser[]; busy: boolean; error: string;
  onConfirm: (reassignTo: string | undefined) => void; onCancel: () => void;
}) {
  const [mode, setMode] = useState<'reassign' | 'delete'>('delete');
  const [target, setTarget] = useState('');
  useEffect(() => { if (open) { setMode('delete'); setTarget(others[0]?.id ?? ''); } }, [open, others]);
  if (!open || !user) return null;
  const canConfirm = mode === 'delete' || (mode === 'reassign' && !!target);
  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 8, color: 'var(--danger, #dc2626)' }}>Offboard {user.name || user.id}?</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 18 }}>
          <strong>{user.id}</strong> will be <strong>PERMANENTLY deleted</strong>, including their
          personal &ldquo;My artifacts&rdquo;. This cannot be undone.
        </div>

        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={mode === 'delete'} onChange={() => setMode('delete')} style={{ marginTop: 3 }} />
            <span><strong>Delete their artifacts</strong> with the account.</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={mode === 'reassign'} onChange={() => setMode('reassign')} disabled={others.length === 0} style={{ marginTop: 3 }} />
            <span>
              <strong>Reassign their &ldquo;My artifacts&rdquo;</strong> to another user, then offboard.
              {mode === 'reassign' && (
                <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: '100%', marginTop: 8 }}>
                  {others.map((o) => <option key={o.id} value={o.id}>{o.name ? `${o.name} (${o.id})` : o.id}</option>)}
                </select>
              )}
            </span>
          </label>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn"
            style={{ background: 'var(--danger, #dc2626)', borderColor: 'var(--danger, #dc2626)', color: '#fff' }}
            disabled={busy || !canConfirm}
            onClick={() => onConfirm(mode === 'reassign' ? target : undefined)}
          >
            {busy ? <span className="spin" /> : 'Offboard permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit user panel — profile, role, domain dropdown, reset password.
// ---------------------------------------------------------------------------
function EditUserPanel({
  open, user, allDomains, busy, error, onSave, onCancel, onResetPassword,
}: {
  open: boolean;
  user: AccessUser | null;
  allDomains: string[];
  busy: boolean;
  error: string;
  onSave: (patch: { name: string; email: string; role: Role; domains: string[] }) => void;
  onCancel: () => void;
  onResetPassword: () => void;
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

  return (
    <div style={{ ...OVERLAY, zIndex: 9998 }} onClick={onCancel}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2 }}>Edit user</div>
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={onResetPassword} disabled={busy}>
            🔑 Reset password
          </button>
        </div>
        <div className="hint" style={{ marginBottom: 16, fontSize: 12 }}><strong>{user.id}</strong></div>

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
          <div>
            <div className="hint" style={{ marginBottom: 6 }}>Domains</div>
            <DomainDropdown available={allDomains} selected={domains} onChange={setDomains} />
            {domains.length === 0 && <div className="hint" style={{ marginTop: 4, color: 'var(--danger)' }}>Select at least one domain</div>}
          </div>
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
// Reset-password dialog.
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
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 4 }}>Reset password</div>
        <div className="hint" style={{ marginBottom: 14, fontSize: 12 }}>
          Set a new password for <strong>{userId}</strong>. It is shown once — share it directly. They set their own on next login.
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <PasswordField value={password} onChange={setPassword} username={userId} />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn" disabled={busy || !password || !strength.ok} onClick={() => onReset(password)}>
            {busy ? <span className="spin" /> : 'Set password'}
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
  const [inviteDomains, setInviteDomains] = useState<string[]>([]);
  const [password, setPassword] = useState('');

  // dialogs
  const [editUser, setEditUser] = useState<AccessUser | null>(null);
  const [editError, setEditError] = useState('');
  const [resetTarget, setResetTarget] = useState<AccessUser | null>(null);
  const [resetError, setResetError] = useState('');
  const [deactivateTarget, setDeactivateTarget] = useState<AccessUser | null>(null);
  const [offboardTarget, setOffboardTarget] = useState<AccessUser | null>(null);
  const [offboardError, setOffboardError] = useState('');
  const [pwResult, setPwResult] = useState<{ id: string; password: string } | null>(null);

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
    const pw = password.trim();
    if (pw && !assessClient(pw, id).ok) { setError(assessClient(pw, id).reasons[0] ?? 'Password too weak'); return; }
    setBusy('invite');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name, role, domains: inviteDomains, ...(pw ? { password: pw } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Invite failed');
      else {
        // Surface the password once ONLY when the server generated it (admin left it blank).
        if (body.generated && body.tempPassword) setPwResult({ id: body.user?.id ?? id, password: body.tempPassword });
        setId(''); setName(''); setInviteDomains([]); setRole('creator'); setPassword('');
        await load();
      }
    } finally {
      setBusy('');
    }
  }, [id, name, role, inviteDomains, password, load]);

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

  const resetPassword = useCallback(async (pw: string) => {
    if (!resetTarget) return;
    setBusy('reset');
    setResetError('');
    try {
      const res = await fetch(`/api/platform-admin/access/${resetTarget.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'reset-password', password: pw }),
      });
      const body = await res.json();
      if (!res.ok) { setResetError(body.error ?? 'Reset failed'); return; }
      if (body.result?.tempPassword) setPwResult({ id: resetTarget.id, password: body.result.tempPassword });
      setResetTarget(null);
      setEditUser(null);
    } catch (e) {
      setResetError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [resetTarget]);

  const confirmDeactivate = useCallback(async () => {
    if (!deactivateTarget) return;
    await patch(deactivateTarget, { op: 'deactivate' });
    setDeactivateTarget(null);
  }, [deactivateTarget, patch]);

  const confirmOffboard = useCallback(async (reassignTo: string | undefined) => {
    if (!offboardTarget) return;
    setBusy(`offboard:${offboardTarget.id}`);
    setOffboardError('');
    try {
      const res = await fetch(`/api/platform-admin/access/${offboardTarget.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(reassignTo ? { reassignTo } : {}),
      });
      const body = await res.json();
      if (!res.ok) { setOffboardError(body.error ?? 'Offboard failed'); return; }
      const failed = body.report?.failed ? Object.keys(body.report.failed) : [];
      if (failed.length) setError(`Offboarded, but could not reassign in: ${failed.join(', ')} — review those artifacts.`);
      setOffboardTarget(null);
      await load();
    } catch (e) {
      setOffboardError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [offboardTarget, load]);

  const sorted = [...users].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));
  const inviteStrong = !password.trim() || assessClient(password.trim(), id).ok;

  return (
    <>
      <PasswordResultDialog
        open={!!pwResult}
        userId={pwResult?.id ?? ''}
        password={pwResult?.password ?? ''}
        onClose={() => setPwResult(null)}
      />
      <EditUserPanel
        open={!!editUser}
        user={editUser}
        allDomains={domains}
        busy={busy.startsWith('edit:')}
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
        open={!!deactivateTarget}
        title={`Deactivate ${deactivateTarget?.name || deactivateTarget?.id}?`}
        body={<>They can no longer sign in; you can reactivate them at any time.</>}
        confirmLabel="Deactivate"
        busy={busy === deactivateTarget?.id}
        onConfirm={confirmDeactivate}
        onCancel={() => setDeactivateTarget(null)}
      />
      <OffboardDialog
        open={!!offboardTarget}
        user={offboardTarget}
        others={users.filter((u) => u.active && u.id !== offboardTarget?.id)}
        busy={busy === `offboard:${offboardTarget?.id}`}
        error={offboardError}
        onConfirm={confirmOffboard}
        onCancel={() => { setOffboardTarget(null); setOffboardError(''); }}
      />

      <PageHeader title="Users & Access" crumb="platform · org-wide identity" />
      <div className="content">
        <p className="lead">
          The <strong>org-wide</strong> identity lifecycle — invite people with a sign-in password,
          set roles and domain memberships, reset passwords, deactivate and offboard. In-domain role
          changes are delegated to Builders in <a href="/governance">Governance</a>.
        </p>

        <div className="hint" style={{ marginBottom: 14 }}>
          SSO {sso?.enabled ? <span className="badge ok">enabled</span> : <span className="badge muted">off</span>}
          {' · '}SCIM {sso?.scim ? <span className="badge ok">on</span> : <span className="badge muted">off</span>}
          {' · '}<a href="/platform/settings">configure in Settings</a>
        </div>

        <div className="section-title">Invite user</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <input style={{ flex: '1 1 180px' }} value={id} onChange={(e) => setId(e.target.value)} placeholder="email / login" />
            <input style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="full name" />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <div className="hint" style={{ marginBottom: 6 }}>Password <span className="muted">(leave blank to generate)</span></div>
              <PasswordField value={password} onChange={setPassword} username={id.trim()} />
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <div className="hint" style={{ marginBottom: 6 }}>Domains</div>
              <DomainDropdown available={domains} selected={inviteDomains} onChange={setInviteDomains} />
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={invite} disabled={busy === 'invite' || !id.trim() || !name.trim() || !inviteStrong}>
              {busy === 'invite' ? <span className="spin" /> : 'Invite user'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            The user signs in with this password (shown once if generated) and sets their own on first login. Only a salted hash is stored.
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
              {sorted.map((u) => (
                <tr key={u.id} style={u.status === 'deactivated' ? { opacity: 0.6 } : undefined}>
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
                    <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={!!busy} onClick={() => { setEditError(''); setEditUser(u); }}>
                      Edit
                    </button>
                    {u.active ? (
                      <button className="btn ghost" style={{ padding: '4px 10px', marginLeft: 6 }} disabled={busy === u.id} onClick={() => setDeactivateTarget(u)}>Deactivate</button>
                    ) : (
                      <button className="btn ghost" style={{ padding: '4px 10px', marginLeft: 6 }} disabled={busy === u.id} onClick={() => patch(u, { op: 'reactivate' })}>Reactivate</button>
                    )}
                    {u.status === 'deactivated' && (
                      <button
                        className="btn ghost"
                        style={{ padding: '4px 10px', marginLeft: 6, color: 'var(--danger)', borderColor: 'rgba(220,38,38,0.35)' }}
                        disabled={busy === `offboard:${u.id}`}
                        onClick={() => { setOffboardError(''); setOffboardTarget(u); }}
                      >
                        Offboard
                      </button>
                    )}
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
