/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

function SignInForm() {
  const params = useSearchParams();
  const next = params.get('next') || '/';

  // The sign-in field is the user's EMAIL (login-by-email). The value is still
  // posted as `username` to the login route, where the directory resolves it
  // against email OR the internal id — so an operator id still works too.
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Sign-in failed');
      } else {
        // FULL-PAGE navigation (not router.push) so Next's client router cache is
        // discarded and the app re-renders fresh under the NEW session — no stale
        // identity/domains or 404s carried over from the previous user's bundle.
        window.location.assign(next);
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
        <div className="signin-sub">Sign in to your domain workspace</div>
        <div className="signin-firstrun">
          First run? Sign in with the bootstrap admin to begin setup.
        </div>

        <form onSubmit={submit} className="signin-form">
          <label>
            Email
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="email"
              inputMode="email"
              placeholder="you@company.com"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••"
            />
          </label>
          {error ? <div className="error">{error}</div> : null}
          <button className="btn" type="submit" disabled={busy || !username || !password}>
            {busy ? <span className="spin" /> : 'Sign in'}
          </button>
        </form>

        <div className="auth-foot">
          <Link href="/recover">Locked out? Recover access</Link>
        </div>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="signin-wrap" />}>
      <SignInForm />
    </Suspense>
  );
}
