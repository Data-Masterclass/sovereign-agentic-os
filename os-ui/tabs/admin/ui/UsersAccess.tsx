/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        admin
 * FEATURE:    Users & Access — invite, assign domains, set a role, offboard, as a Platform tab
 * USER STORY: As a platform admin I want to administer people — invite, assign domains, change a
 *             role, deactivate, offboard — in Platform, while what a role MAY DO stays policy in
 *             Governance (cross-linked both ways).
 * ARCHITECTURE:
 *   - Markup carried over unchanged from app/(govern)/platform/access/page.tsx (2026-10-30 move
 *     to one route with tabs on top, not a redesign). That route is now a redirect to
 *     /platform?section=access — the cross-link in Governance’s RolesView still resolves.
 *   - The page's `.content` wrapper moved up to platform/page.tsx; the leftover plain <div> is it.
 *   - FAIL-CLOSED gate: Platform is minRole 'builder' (only Overview & Health is builder-readable),
 *     and every section now lives at /platform, so the old pathname gate in platform/layout.tsx no
 *     longer protects this surface. The gate is therefore HERE as well as in the strip: the inner
 *     component — which holds every hook and every fetch — is not mounted until useUser() resolves a
 *     role that clears sectionMinRole('access'). A builder who hand-crafts ?section=access gets nothing,
 *     and nothing is requested on their behalf. Hiding is not the boundary: /api/platform-admin/* is
 *     adminCtx()-gated server-side, which is the real enforcement.
 * I18N:       converted (wave 2) — texts from `admin.users.*`. Role names stay English; password-strength
 *             reasons come from @core/kernel/password-strength and server errors render as sent.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import { assessPasswordStrength } from '@core/kernel/password-strength';
import { useTranslations } from '@core/i18n/client';

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

// Password strength: the server's own rule (`@core/kernel/password-strength`). The API still
// re-checks; this is live feedback, but it is the same function, not a mirror.
const SCORE_COLOR = ['#dc2626', '#f97316', '#eab308', '#22c55e', '#16a34a'];
const SCORE_LABEL = ['veryWeak', 'weak', 'fair', 'strong', 'veryStrong'] as const;

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
  const t = useTranslations('admin');
  const strength = assessPasswordStrength(value, username);

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
            placeholder={t('users.password.placeholder')}
            style={{ width: '100%', paddingRight: 60 }}
            autoComplete="new-password"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--muted, #6b7280)', padding: '2px 4px' }}
            tabIndex={-1}
          >
            {show ? t('users.password.hide') : t('users.password.show')}
          </button>
        </div>
        <button type="button" className="btn ghost" style={{ padding: '6px 10px', fontSize: 12, flexShrink: 0 }} onClick={copy} disabled={!value}>
          {copied ? t('users.password.copied') : t('users.password.copy')}
        </button>
        <button type="button" className="btn ghost" style={{ padding: '6px 10px', fontSize: 12, flexShrink: 0 }} onClick={generate} disabled={generating}>
          {generating ? <span className="spin" /> : t('users.password.generate')}
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
            {strength.ok ? t(`users.strength.${SCORE_LABEL[strength.score]}`) : strength.reasons[0]}
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
  const t = useTranslations('admin');

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!available.length) return <div className="hint">{t('users.domainPicker.none')}</div>;

  function toggle(d: string) {
    onChange(selected.includes(d) ? selected.filter((x) => x !== d) : [...selected, d]);
  }
  const label = selected.length === 0 ? t('users.domainPicker.select') : selected.join(', ');

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
  const tc = useTranslations('common');
  if (!open) return null;
  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={{ ...PANEL, width: 400 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 8 }}>{title}</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 22 }}>{body}</div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>{tc('actions.cancel')}</button>
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
  const t = useTranslations('admin');
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
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 8 }}>{t('users.pwResult.title')}</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
          {t.rich('users.pwResult.body', { userId, strong: (c) => <strong>{c}</strong> })}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', background: 'var(--code-bg, #f4f4f5)', border: '1px solid var(--border, #e5e7eb)', borderRadius: 10, padding: '10px 12px', marginBottom: 18 }}>
          <code style={{ flex: 1, fontSize: 15, letterSpacing: 0.5, wordBreak: 'break-all' }}>{password}</code>
          <button className="btn" style={{ padding: '4px 12px', fontSize: 12, flexShrink: 0 }} onClick={copy}>{copied ? t('users.password.copied') : t('users.password.copy')}</button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>{t('users.pwResult.done')}</button>
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
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  useEffect(() => { if (open) { setMode('delete'); setTarget(others[0]?.id ?? ''); } }, [open, others]);
  if (!open || !user) return null;
  const canConfirm = mode === 'delete' || (mode === 'reassign' && !!target);
  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 8, color: 'var(--danger, #dc2626)' }}>{t('users.offboard.title', { name: user.name || user.id })}</div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 18 }}>
          {t.rich('users.offboard.body', { id: user.id, strong: (c) => <strong>{c}</strong> })}
        </div>

        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={mode === 'delete'} onChange={() => setMode('delete')} style={{ marginTop: 3 }} />
            <span>{t.rich('users.offboard.deleteOption', { strong: (c) => <strong>{c}</strong> })}</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', fontSize: 13 }}>
            <input type="radio" checked={mode === 'reassign'} onChange={() => setMode('reassign')} disabled={others.length === 0} style={{ marginTop: 3 }} />
            <span>
              {t.rich('users.offboard.reassignOption', { strong: (c) => <strong>{c}</strong> })}
              {mode === 'reassign' && (
                <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: '100%', marginTop: 8 }}>
                  {others.map((o) => <option key={o.id} value={o.id}>{o.name ? `${o.name} (${o.id})` : o.id}</option>)}
                </select>
              )}
            </span>
          </label>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>{tc('actions.cancel')}</button>
          <button
            className="btn"
            style={{ background: 'var(--danger, #dc2626)', borderColor: 'var(--danger, #dc2626)', color: '#fff' }}
            disabled={busy || !canConfirm}
            onClick={() => onConfirm(mode === 'reassign' ? target : undefined)}
          >
            {busy ? <span className="spin" /> : t('users.offboard.confirm')}
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
  const t = useTranslations('admin');
  const tc = useTranslations('common');

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
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2 }}>{t('users.edit.title')}</div>
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={onResetPassword} disabled={busy}>
            {t('users.edit.resetPassword')}
          </button>
        </div>
        <div className="hint" style={{ marginBottom: 16, fontSize: 12 }}><strong>{user.id}</strong></div>

        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="hint" style={{ marginBottom: 4 }}>{t('users.edit.fullName')}</div>
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} placeholder={t('users.edit.fullName')} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 4 }}>{t('users.edit.email')}</div>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} placeholder={t('users.edit.emailPlaceholder')} />
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 4 }}>{t('users.edit.role')}</div>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ width: '100%' }}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <div className="hint" style={{ marginBottom: 6 }}>{t('users.edit.domains')}</div>
            <DomainDropdown available={allDomains} selected={domains} onChange={setDomains} />
            {domains.length === 0 && <div className="hint" style={{ marginTop: 4, color: 'var(--danger)' }}>{t('users.edit.needDomain')}</div>}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>{tc('actions.cancel')}</button>
          <button
            className="btn"
            disabled={busy || !name.trim() || domains.length === 0}
            onClick={() => onSave({ name: name.trim(), email: email.trim(), role, domains })}
          >
            {busy ? <span className="spin" /> : t('users.edit.save')}
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
  const strength = assessPasswordStrength(password, userId);
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  useEffect(() => { if (!open) setPassword(''); }, [open]);
  if (!open) return null;
  return (
    <div style={OVERLAY} onClick={onCancel}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2, marginBottom: 4 }}>{t('users.reset.title')}</div>
        <div className="hint" style={{ marginBottom: 14, fontSize: 12 }}>
          {t.rich('users.reset.body', { userId, strong: (c) => <strong>{c}</strong> })}
        </div>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <PasswordField value={password} onChange={setPassword} username={userId} />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>{tc('actions.cancel')}</button>
          <button className="btn" disabled={busy || !password || !strength.ok} onClick={() => onReset(password)}>
            {busy ? <span className="spin" /> : t('users.reset.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function UsersAccess() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  // Fail closed: UsersAccessInner holds every hook and every fetch, so until the role
  // resolves AND clears the floor nothing renders and nothing is requested.
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('access'))) return null;
  return <UsersAccessInner />;
}

function UsersAccessInner() {
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
  const t = useTranslations('admin');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/access', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('users.errors.load'));
      else {
        setUsers(body.users ?? []);
        setDomains(body.domains ?? []);
        setSso(body.sso ?? null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const invite = useCallback(async () => {
    if (!id.trim() || !name.trim()) return;
    const pw = password.trim();
    if (pw && !assessPasswordStrength(pw, id).ok) { setError(assessPasswordStrength(pw, id).reasons[0] ?? t('users.errors.weak')); return; }
    setBusy('invite');
    setError('');
    try {
      const res = await fetch('/api/platform-admin/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name, role, domains: inviteDomains, ...(pw ? { password: pw } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('users.errors.invite'));
      else {
        // Surface the password once ONLY when the server generated it (admin left it blank).
        if (body.generated && body.tempPassword) setPwResult({ id: body.user?.id ?? id, password: body.tempPassword });
        setId(''); setName(''); setInviteDomains([]); setRole('creator'); setPassword('');
        await load();
      }
    } finally {
      setBusy('');
    }
  }, [id, name, role, inviteDomains, password, load, t]);

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
        setError(b.error ?? t('users.errors.update'));
      } else await load();
    } finally {
      setBusy('');
    }
  }, [load, t]);

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
      if (!res.ok) { setEditError(body.error ?? t('users.errors.save')); return; }
      setEditUser(null);
      await load();
    } catch (e) {
      setEditError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [editUser, load, t]);

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
      if (!res.ok) { setResetError(body.error ?? t('users.errors.reset')); return; }
      if (body.result?.tempPassword) setPwResult({ id: resetTarget.id, password: body.result.tempPassword });
      setResetTarget(null);
      setEditUser(null);
    } catch (e) {
      setResetError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [resetTarget, t]);

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
      if (!res.ok) { setOffboardError(body.error ?? t('users.errors.offboard')); return; }
      const failed = body.report?.failed ? Object.keys(body.report.failed) : [];
      if (failed.length) setError(t('users.errors.reassignPartial', { list: failed.join(', ') }));
      setOffboardTarget(null);
      await load();
    } catch (e) {
      setOffboardError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [offboardTarget, load, t]);

  const sorted = [...users].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id));
  const inviteStrong = !password.trim() || assessPasswordStrength(password.trim(), id).ok;

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
        title={t('users.deactivate.title', { name: deactivateTarget?.name || deactivateTarget?.id || '' })}
        body={t('users.deactivate.body')}
        confirmLabel={t('users.deactivate.confirm')}
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

      <div>
        {/* The one workflow cost of the split: assigning a person a role is here,
            defining what that role MAY DO is policy and lives in Governance. One
            click each way — the Roles & permissions tab links straight back. */}
        <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
          {t.rich('users.rolesHint', { strong: (c) => <strong>{c}</strong>, link: (c) => <a href="/governance?section=roles">{c}</a> })}
        </p>

        <div className="hint" style={{ marginBottom: 14 }}>
          {t.rich('users.ssoLine', {
            ssoState: sso?.enabled ? t('users.badge.enabled') : t('users.badge.off'),
            scimState: sso?.scim ? t('users.badge.on') : t('users.badge.off'),
            sso: (c) => <span className={`badge ${sso?.enabled ? 'ok' : 'muted'}`}>{c}</span>,
            scim: (c) => <span className={`badge ${sso?.scim ? 'ok' : 'muted'}`}>{c}</span>,
            link: (c) => <a href="/platform?section=settings">{c}</a>,
          })}
        </div>

        <div className="section-title">{t('users.invite.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <input style={{ flex: '1 1 180px' }} value={id} onChange={(e) => setId(e.target.value)} placeholder={t('users.invite.idPlaceholder')} />
            <input style={{ flex: '1 1 160px' }} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('users.invite.namePlaceholder')} />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 260px' }}>
              <div className="hint" style={{ marginBottom: 6 }}>{t.rich('users.invite.password', { muted: (c) => <span className="muted">{c}</span> })}</div>
              <PasswordField value={password} onChange={setPassword} username={id.trim()} />
            </div>
            <div style={{ flex: '1 1 220px' }}>
              <div className="hint" style={{ marginBottom: 6 }}>{t('users.invite.domains')}</div>
              <DomainDropdown available={domains} selected={inviteDomains} onChange={setInviteDomains} />
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={invite} disabled={busy === 'invite' || !id.trim() || !name.trim() || !inviteStrong}>
              {busy === 'invite' ? <span className="spin" /> : t('users.invite.submit')}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {t('users.invite.footnote')}
          </div>
        </div>

        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">{t('users.people')}<span className="count-pill">{users.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{t('users.table.user')}</th><th>{t('users.table.domains')}</th><th>{t('users.table.role')}</th><th>{t('users.table.status')}</th><th>{t('users.table.tenantAdmin')}</th><th></th></tr>
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
                  <td><span className={`badge ${STATUS_BADGE[u.status]}`}>{t(`users.status.${u.status}`)}</span></td>
                  <td>
                    <button
                      className={'switch' + (u.role === 'admin' ? ' on' : '')}
                      disabled={busy === u.id}
                      onClick={() => patch(u, { op: 'tenant-admin', isAdmin: u.role !== 'admin' })}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{u.role === 'admin' ? t('users.switch.on') : t('users.switch.off')}</span>
                    </button>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost" style={{ padding: '4px 10px' }} disabled={!!busy} onClick={() => { setEditError(''); setEditUser(u); }}>
                      {t('users.edit.button')}
                    </button>
                    {u.active ? (
                      <button className="btn ghost" style={{ padding: '4px 10px', marginLeft: 6 }} disabled={busy === u.id} onClick={() => setDeactivateTarget(u)}>{t('users.deactivate.confirm')}</button>
                    ) : (
                      <button className="btn ghost" style={{ padding: '4px 10px', marginLeft: 6 }} disabled={busy === u.id} onClick={() => patch(u, { op: 'reactivate' })}>{t('users.reactivate')}</button>
                    )}
                    {u.status === 'deactivated' && (
                      <button
                        className="btn ghost"
                        style={{ padding: '4px 10px', marginLeft: 6, color: 'var(--danger)', borderColor: 'rgba(220,38,38,0.35)' }}
                        disabled={busy === `offboard:${u.id}`}
                        onClick={() => { setOffboardError(''); setOffboardTarget(u); }}
                      >
                        {t('users.offboard.button')}
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
