/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { assessPasswordStrength } from '@core/kernel/password-strength';
import { PasswordStrengthMeter } from '@core/ui/PasswordStrengthMeter';

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

  const strongEnough = assessPasswordStrength(password, username).ok;
  const passwordsMatch = password === confirm;
  const canSubmit = !!(username && key && password && confirm && passwordsMatch && strongEnough && !busy);

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
                <PasswordStrengthMeter password={password} username={username} />
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
