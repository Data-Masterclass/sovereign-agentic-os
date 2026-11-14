/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Access tokens — create, see once, revoke
 * USER STORY: As an engineer I want to create a personal access token here, copy it once, use it
 *             for `git clone`/`git push`, see afterwards only its prefix and when it was last
 *             used, and revoke it the moment I lose the laptop (E-R2.1, checklist E2).
 * ARCHITECTURE:
 *   - A SHELL over `/api/git/tokens`. No logic worth testing lives here; the format, the hashing
 *     and the resolution are `core/auth/access-tokens*.ts`, which the unit tests drive.
 *   - PERSONAL, not administration: this section lists only the caller's own tokens and needs no
 *     admin role. It is in Platform because that is where the OS keeps account-level settings.
 *   - The plaintext token is held in component state for exactly as long as the panel shows it and
 *     is never re-fetchable. The list endpoint cannot return it — there is nothing to return.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type TokenView = {
  id: string;
  prefix: string;
  name: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number;
  lastUsedAt: number;
};

const when = (ms: number) => (ms ? new Date(ms).toLocaleDateString() : '—');

export default function AccessTokens() {
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/git/tokens');
      const j = (await r.json()) as { tokens?: TokenView[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setTokens(j.tokens ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTokens([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/git/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = (await r.json()) as { token?: string; error?: string };
      if (!r.ok || !j.token) throw new Error(j.error ?? `HTTP ${r.status}`);
      setFresh(j.token);
      setName('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      const r = await fetch(`/api/git/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section>
      <h3>Access tokens</h3>
      <p className="muted" style={{ maxWidth: 760 }}>
        A personal access token is how your git client proves it is you. Use it as the password for{' '}
        <code>git clone</code>, <code>git fetch</code> and <code>git push</code> against{' '}
        <code>/git/&lt;domain&gt;.git</code>; any username works. It is stored hashed, shown once, and acts with
        exactly your own role and domains — never more.
      </p>

      {fresh ? (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <strong>Copy this now — it is not shown again.</strong>
          <pre style={{ overflowX: 'auto', margin: '8px 0' }}>{fresh}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-small" onClick={() => void navigator.clipboard?.writeText(fresh)}>
              Copy
            </button>
            <button className="btn-small" onClick={() => setFresh(null)}>
              I have saved it
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <input
          placeholder="What is it for? (e.g. laptop, VS Code)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ minWidth: 260 }}
        />
        <button onClick={() => void create()} disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create token'}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {tokens === null ? (
        <p className="muted">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="muted">No tokens yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <code>sos_{t.prefix}_…</code>
                </td>
                <td>{when(t.createdAt)}</td>
                <td>{when(t.expiresAt)}</td>
                <td>{when(t.lastUsedAt)}</td>
                <td>{t.revokedAt ? 'revoked' : t.expiresAt && t.expiresAt <= Date.now() ? 'expired' : 'active'}</td>
                <td>
                  {t.revokedAt ? null : (
                    <button className="btn-small" onClick={() => void revoke(t.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
