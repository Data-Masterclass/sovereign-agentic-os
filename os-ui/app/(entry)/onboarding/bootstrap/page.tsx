/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * I18N: converted (wave 2) — strings from the `home` namespace (`home.bootstrap.*`, `home.auth.*`). The server's
 * error text and password reasons are shown as written.
 */
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import { assessPasswordStrength } from '@core/kernel/password-strength';
import { PasswordStrengthMeter } from '@core/ui/PasswordStrengthMeter';

/* ---- Page ---- */

export default function BootstrapPage() {
  const t = useTranslations('home');
  const [username, setUsername] = useState('admin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Which forced-setup flow: the first-run bootstrap admin (chooses username +
  // email) or an INVITED user replacing a one-time temp password (login fixed).
  const [invited, setInvited] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b: { user?: { id: string; name?: string } | null; bootstrap?: boolean; email?: string | null; mustChangeCredentials?: boolean }) => {
        if (!alive) return;
        const isInvited = Boolean(b?.user && b.mustChangeCredentials && !b.bootstrap);
        setInvited(isInvited);
        if (isInvited && b.user) {
          // Login id + email are fixed for an invited user; prefill (read-only).
          setUsername(b.user.id);
          setEmail(b.email ?? b.user.id);
          setName(b.user.name && b.user.name !== b.user.id ? b.user.name : '');
        }
      })
      .catch(() => { if (alive) setInvited(false); });
    return () => { alive = false; };
  }, []);

  const strongEnough = assessPasswordStrength(password, username).ok;
  const passwordsMatch = password === confirm;
  const canSubmit = !!(
    username && (invited || email) && password && confirm && passwordsMatch && strongEnough && !busy
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    setReasons([]);
    try {
      const res = await fetch('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, email, password, name: name || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? t('bootstrap.failed'));
        setReasons(body.reasons ?? []);
        setBusy(false);
      } else {
        // Account is created, active and signed in. Go straight into the app —
        // no email verification step (the bootstrap operator is trusted; the
        // default admin/admin is already gone). Full reload so AuthGate re-reads
        // the new session and runs onboarding.
        // The first-run admin continues to setup step 2 (where encryption keys live); an invited
        // user goes straight in.
        window.location.href = invited ? '/' : '/onboarding/encryption';
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="signin-wrap">
      <div className="signin-card auth-card-wide">
        <div className="signin-brand">
          Sovereign <span className="accent">Agentic</span> OS
        </div>

        <div className="signin-sub" style={{ marginTop: 8 }}>
          {invited ? t('bootstrap.titleInvited') : t('bootstrap.title')}
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 13, color: '#b0a99c', lineHeight: 1.6 }}>
          {invited ? t('bootstrap.introInvited') : t('bootstrap.intro')}
        </p>

        <form onSubmit={submit} className="signin-form" style={{ marginTop: 20 }}>
              <label>
                {t('auth.username')}
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  // i18n-ignore — the bootstrap login id itself, not a word
                  placeholder="admin"
                  readOnly={!!invited}
                  disabled={!!invited}
                />
              </label>

              <label>
                {t('bootstrap.fullName')} <span className="auth-optional">{t('bootstrap.optional')}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder={t('bootstrap.namePlaceholder')}
                />
              </label>

              <label>
                {t('bootstrap.email')}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder={t('bootstrap.emailPlaceholder')}
                  readOnly={!!invited}
                  disabled={!!invited}
                />
              </label>

              <div>
                <label>
                  {t('auth.newPassword')}
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="••••••••••••"
                  />
                </label>
                <PasswordStrengthMeter password={password} username={username} />
              </div>

              <div>
                <label>
                  {t('bootstrap.confirmPassword')}
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    placeholder="••••••••••••"
                  />
                </label>
                {confirm && !passwordsMatch && (
                  <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: '#c0392b' }}>
                    {t('auth.mismatch')}
                  </span>
                )}
              </div>

              {error && (
                <div className="error">
                  {error}
                  {reasons.length > 0 && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                      {reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

          <button className="btn" type="submit" disabled={!canSubmit}>
            {busy ? <span className="spin" /> : invited ? t('bootstrap.submitInvited') : t('bootstrap.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
