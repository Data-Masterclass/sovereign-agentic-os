/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type RosterUser = { id: string; name: string; domain: string; role: string };

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [roster, setRoster] = useState<RosterUser[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((b) => setRoster(b.roster ?? []))
      .catch(() => {});
  }, []);

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
        router.replace(next);
        router.refresh();
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

        <form onSubmit={submit} className="signin-form">
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus placeholder="e.g. amir" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
          </label>
          {error ? <div className="error">{error}</div> : null}
          <button className="btn" type="submit" disabled={busy || !username || !password}>
            {busy ? <span className="spin" /> : 'Sign in'}
          </button>
        </form>

        {roster.length > 0 ? (
          <div className="signin-roster">
            <div className="hint" style={{ marginTop: 0 }}>Teaching roster — click to prefill:</div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {roster.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="chip"
                  style={{ cursor: 'pointer', background: 'transparent' }}
                  onClick={() => {
                    setUsername(u.id);
                    setPassword(u.domain === 'platform' ? 'admin' : u.domain);
                  }}
                  title={`${u.domain} · ${u.role}`}
                >
                  {u.id} · {u.domain}/{u.role}
                </button>
              ))}
            </div>
            <div className="hint" style={{ fontSize: 11 }}>
              Passwords mirror the domain (sales/finance), platform admin = “admin”. Seeded; replace via OS_USERS / Ory.
            </div>
          </div>
        ) : null}
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
