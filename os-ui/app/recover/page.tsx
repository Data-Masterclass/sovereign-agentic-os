/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';

/* ---- Password strength helpers ---- */

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

export default function RecoverPage() {
  const [username, setUsername] = useState('');
  const [key, setKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const { unmet } = getStrength(password, username);
  const passwordsMatch = password === confirm;
  const canSubmit = !!(username && key && password && confirm && passwordsMatch && unmet.length === 0 && !busy);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    setReasons([]);
    try {
      const res = await fetch('/api/auth/recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, key, newPassword: password }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Recovery failed');
        setReasons(body.reasons ?? []);
      } else {
        setDone(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin-wrap">
      <div className="signin-card">
        <div className="signin-brand">
          Sovereign <span className="accent">Agentic</span> OS
        </div>

        {done ? (
          <div className="auth-verify-panel" style={{ marginTop: 24 }}>
            <span className="auth-verify-icon">✓</span>
            <div className="auth-verify-title">Password updated</div>
            <div className="auth-verify-desc">
              Your password has been reset. You can now sign in with your new credentials.
            </div>
            <Link href="/signin" className="btn" style={{ display: 'inline-block' }}>
              Back to sign in
            </Link>
          </div>
        ) : (
          <>
            <div className="signin-sub" style={{ marginTop: 8 }}>Recover access</div>
            <p style={{ margin: '10px 0 0', fontSize: 13, color: '#8a8270', lineHeight: 1.55 }}>
              Locked out? Enter your username and your master recovery key to set a new password.
            </p>

            <form onSubmit={submit} className="signin-form" style={{ marginTop: 18 }}>
              <label>
                Username
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  autoComplete="username"
                  placeholder="your username"
                />
              </label>

              <label>
                Master recovery key
                <input
                  type="text"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                  placeholder="paste your recovery key"
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
                  Confirm new password
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
                {busy ? <span className="spin" /> : 'Reset password'}
              </button>
            </form>

            <div className="auth-foot" style={{ textAlign: 'left' }}>
              <span style={{ color: '#6a6258', fontSize: 12 }}>
                Lost your recovery key? It cannot be recovered — you would need to reset the deployment.
              </span>
            </div>
            <div className="auth-foot plain">
              <Link href="/signin">← Back to sign in</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
