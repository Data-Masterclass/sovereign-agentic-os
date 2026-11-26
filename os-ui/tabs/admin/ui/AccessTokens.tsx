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
 * I18N:       converted (wave 2) — texts from `admin.tokens.*`. Error texts from the API are shown as they come.
 */
'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations, useFormat } from '@core/i18n/client';

type TokenView = {
  id: string;
  prefix: string;
  name: string;
  scope: string;
  access?: 'read' | 'write';
  repos?: string[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number;
  lastUsedAt: number;
};

export default function AccessTokens() {
  const t = useTranslations('admin');
  const f = useFormat();
  // A short numeric date in the active language (en unchanged: "11/27/2026").
  const when = (ms: number) => (ms ? f.date(ms, {}) : '—');
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [repos, setRepos] = useState('');
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
        body: JSON.stringify({
          name,
          access,
          repos: repos.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean),
        }),
      });
      const j = (await r.json()) as { token?: string; error?: string };
      if (!r.ok || !j.token) throw new Error(j.error ?? `HTTP ${r.status}`);
      setFresh(j.token);
      setName('');
      setRepos('');
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
      <h3>{t('tokens.title')}</h3>
      <p className="muted" style={{ maxWidth: 760 }}>
        {t.rich('tokens.intro', {
          path: '/git/<domain>.git',
          code: (c: ReactNode) => <code>{c}</code>,
        })}
      </p>

      {fresh ? (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          <strong>{t('tokens.copyNow')}</strong>
          <pre style={{ overflowX: 'auto', margin: '8px 0' }}>{fresh}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-small" onClick={() => void navigator.clipboard?.writeText(fresh)}>
              {t('tokens.copy')}
            </button>
            <button className="btn-small" onClick={() => setFresh(null)}>
              {t('tokens.saved')}
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <input
          placeholder={t('tokens.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ minWidth: 260 }}
        />
        <select value={access} onChange={(e) => setAccess(e.target.value === 'write' ? 'write' : 'read')} aria-label={t('tokens.accessAria')}>
          <option value="read">{t('tokens.optRead')}</option>
          <option value="write">{t('tokens.optWrite')}</option>
        </select>
        <input
          placeholder={t('tokens.reposPlaceholder')}
          value={repos}
          onChange={(e) => setRepos(e.target.value)}
          style={{ minWidth: 260 }}
        />
        <button onClick={() => void create()} disabled={busy || !name.trim()}>
          {busy ? t('tokens.creating') : t('tokens.create')}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {tokens === null ? (
        <p className="muted">{t('tokens.loading')}</p>
      ) : tokens.length === 0 ? (
        <p className="muted">{t('tokens.empty')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('tokens.thName')}</th>
              <th>{t('tokens.thPrefix')}</th>
              <th>{t('tokens.thAccess')}</th>
              <th>{t('tokens.thCreated')}</th>
              <th>{t('tokens.thExpires')}</th>
              <th>{t('tokens.thLastUsed')}</th>
              <th>{t('tokens.thStatus')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((tok) => (
              <tr key={tok.id}>
                <td>{tok.name}</td>
                <td>
                  {/* i18n-ignore: the token's literal format (sos_<prefix>_…), not prose */}
                  <code>sos_{tok.prefix}_…</code>
                </td>
                <td>
                  {tok.access === 'read' ? t('tokens.accessRead') : t('tokens.accessWrite')}
                  {tok.repos?.length ? ` · ${tok.repos.join(', ')}` : ''}
                </td>
                <td>{when(tok.createdAt)}</td>
                <td>{when(tok.expiresAt)}</td>
                <td>{when(tok.lastUsedAt)}</td>
                <td>{tok.revokedAt ? t('tokens.statusRevoked') : tok.expiresAt && tok.expiresAt <= Date.now() ? t('tokens.statusExpired') : t('tokens.statusActive')}</td>
                <td>
                  {tok.revokedAt ? null : (
                    <button className="btn-small" onClick={() => void revoke(tok.id)}>
                      {t('tokens.revoke')}
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
