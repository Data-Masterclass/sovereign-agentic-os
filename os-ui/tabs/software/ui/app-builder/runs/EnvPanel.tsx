/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Env panel: an app's env variables and secrets in Dev or Prod (write-only)
 * USER STORY: As an app builder I set, see by name and remove my app's env and secrets per env; a value is never
 *             shown again after I save it.
 * ARCHITECTURE:
 *   - Workstream D's panel inside the Code and runs view (C2 places it; spec section 11 view 3). Talks only to
 *     `/api/apps/[id]/env` (GET list, PUT set, DELETE remove), the same functions as the MCP tools.
 *   - The value field is a password input and is cleared after every save; the list shows name, kind, who and when.
 *   - The name rule is `lib/appdb/env-names.ts`, the one the server enforces; its code is rendered in the user's
 *     language. Text: `software.appBuilder.env.*`.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormat, useServerMessage, useTranslations } from '@core/i18n/client';
import type { AppEnv } from '@tabs/software/lib/app-builder-contracts';
import { envNameProblem } from '@tabs/software/lib/appdb/env-names';
import type { EnvEntry } from '@tabs/software/lib/appdb/env-secrets';
import type { AppBuilderApp } from '@tabs/software/ui/app-builder/AppBuilderShell';

export default function EnvPanel({ app, env }: { app: AppBuilderApp; env: AppEnv }) {
  const t = useTranslations('software');
  const f = useFormat();
  const serverMessage = useServerMessage();
  const [entries, setEntries] = useState<EnvEntry[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [secret, setSecret] = useState(true);
  const [busy, setBusy] = useState(false);
  const base = `/api/apps/${encodeURIComponent(app.id)}/env`;

  const load = useCallback(async () => {
    setError('');
    const res = await fetch(`${base}?env=${env}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setEntries([]);
      setError(serverMessage(body, t('appBuilder.env.loadFailed')));
      return;
    }
    setEntries((body as { entries: EnvEntry[] }).entries);
  }, [base, env, serverMessage, t]);

  useEffect(() => {
    setNotice('');
    void load();
  }, [load]);

  const problem = name ? envNameProblem(name) : null;
  const problemText = !problem
    ? ''
    : problem.code === 'pattern'
      ? t('appBuilder.env.namePattern')
      : problem.code === 'prefix'
        ? t('appBuilder.env.namePrefix', { prefix: problem.prefix })
        : t('appBuilder.env.nameReserved', { name: problem.name });

  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    const res = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env, name, value, secret }) });
    const body = await res.json().catch(() => ({}));
    // The value never stays in the page, whatever the answer.
    setValue('');
    setBusy(false);
    if (!res.ok) {
      setError(serverMessage(body, t('appBuilder.env.saveFailed')));
      return;
    }
    setNotice(t('appBuilder.env.saved', { name }));
    setName('');
    void load();
  }

  async function remove(n: string) {
    setBusy(true);
    setError('');
    setNotice('');
    const res = await fetch(`${base}?env=${env}&name=${encodeURIComponent(n)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(serverMessage(body, t('appBuilder.env.removeFailed')));
      return;
    }
    setNotice(t('appBuilder.env.removed', { name: n }));
    void load();
  }

  const envLabel = t(`appBuilder.shell.${env}`);
  return (
    <section className="card" data-testid="app-builder-env">
      <h4>{t('appBuilder.env.title', { env: envLabel })}</h4>
      <p className="muted">{t('appBuilder.env.intro')}</p>
      {env === 'prod' && <p className="muted">{t('appBuilder.env.prodRight')}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {entries === null ? (
        <p className="muted">{t('appBuilder.env.loading')}</p>
      ) : entries.length === 0 ? (
        <p className="muted">{t('appBuilder.env.empty', { env: envLabel })}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('appBuilder.env.name')}</th>
              <th>{t('appBuilder.env.kind')}</th>
              <th>{t('appBuilder.env.updated')}</th>
              <th aria-label={t('appBuilder.env.actions')} />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.name}>
                <td><code>{e.name}</code></td>
                <td>{t(`appBuilder.env.kinds.${e.kind}`)}</td>
                <td className="muted">
                  {e.updatedAt ? t('appBuilder.env.updatedBy', { who: e.updatedBy || '?', when: f.relativeTime(e.updatedAt) }) : ''}
                </td>
                <td>
                  {e.kind !== 'platform' && (
                    <button type="button" disabled={busy} onClick={() => void remove(e.name)}>
                      {t('appBuilder.env.remove')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!problem && name && !busy) void save();
        }}
      >
        <label>
          {t('appBuilder.env.name')}
          <input value={name} onChange={(ev) => setName(ev.target.value.toUpperCase())} placeholder={t('appBuilder.env.namePlaceholder')} autoComplete="off" spellCheck={false} />
        </label>
        {problemText && <p className="muted">{problemText}</p>}
        <label>
          {t('appBuilder.env.value')}
          <input type="password" value={value} onChange={(ev) => setValue(ev.target.value)} autoComplete="new-password" />
        </label>
        <label>
          <input type="checkbox" checked={secret} onChange={(ev) => setSecret(ev.target.checked)} /> {t('appBuilder.env.isSecret')}
        </label>
        <p className="muted">{t('appBuilder.env.writeOnly')}</p>
        <button type="submit" disabled={busy || !name || !!problem}>
          {t('appBuilder.env.save')}
        </button>
      </form>
    </section>
  );
}
