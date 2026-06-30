/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';

/* ---- Password strength helpers (mirror server rules; server re-checks) ---- */

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789',
  '1234567890', 'qwerty', 'qwerty123', 'abc123', 'iloveyou',
  'letmein', 'welcome', 'admin1234', 'monkey', 'dragon', 'master',
  'sunshine', 'football', 'baseball', 'trustno1', 'access',
]);

function getStrength(pw: string, user: string): { score: number; unmet: string[] } {
  const unmet: string[] = [];
  if (pw.length < 12) unmet.push('At least 12 characters');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) unmet.push('Mix of lowercase, uppercase, digit, and symbol (need 3 of 4)');
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) unmet.push('Too common a password');
  if (user && pw.toLowerCase().includes(user.toLowerCase())) unmet.push('Must not contain your username');
  return { score: Math.max(0, 4 - unmet.length), unmet };
}

const FILL_COLORS = ['#c0392b', '#e06a2a', '#c8a24a', '#2aa39b', '#2aa39b'];

function StrengthMeter({ password, username }: { password: string; username: string }) {
  if (!password) return null;
  const { score, unmet } = getStrength(password, username);
  return (
    <div className="auth-strength-wrap">
      <div className="auth-strength-bar">
        <div
          className="auth-strength-fill"
          style={{ width: `${(score + 1) * 20}%`, backgroundColor: FILL_COLORS[score] }}
        />
      </div>
      <div className="auth-strength-rules">
        {unmet.length === 0 ? (
          <div className="auth-strength-rule">✓ Strong password</div>
        ) : (
          unmet.map((r) => (
            <div key={r} className="auth-strength-rule unmet">
              ✗ {r}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---- Page ---- */

export default function BootstrapPage() {
  const [username, setUsername] = useState('admin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const { unmet } = getStrength(password, username);
  const passwordsMatch = password === confirm;
  const canSubmit = !!(
    username && email && password && confirm && passwordsMatch && unmet.length === 0 && !busy
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
        setError(body.error ?? 'Setup failed');
        setReasons(body.reasons ?? []);
        setBusy(false);
      } else {
        // Account is created, active and signed in. Go straight into the app —
        // no email verification step (the bootstrap operator is trusted; the
        // default admin/admin is already gone). Full reload so AuthGate re-reads
        // the new session and runs onboarding.
        window.location.href = '/';
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

        <div className="signin-sub" style={{ marginTop: 8 }}>Secure your deployment</div>
        <p style={{ margin: '12px 0 0', fontSize: 13, color: '#b0a99c', lineHeight: 1.6 }}>
          You're signed in with the temporary bootstrap admin. Set a real admin account to
          continue — the default admin/admin login is deleted the moment you finish, and your
          account is active right away.
        </p>

        <form onSubmit={submit} className="signin-form" style={{ marginTop: 20 }}>
              <label>
                Username
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="admin"
                />
              </label>

              <label>
                Full name <span className="auth-optional">optional</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="Your name"
                />
              </label>

              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </label>

              <div>
                <label>
                  New password
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="••••••••••••"
                  />
                </label>
                <StrengthMeter password={password} username={username} />
              </div>

              <div>
                <label>
                  Confirm password
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
                    Passwords do not match
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
            {busy ? <span className="spin" /> : 'Create admin & continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
