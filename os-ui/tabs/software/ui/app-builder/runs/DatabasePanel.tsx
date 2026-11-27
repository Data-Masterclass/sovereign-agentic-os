/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Database panel: an app's own Postgres database in Dev or Prod
 * USER STORY: As an app builder I create my app's database with one click and see its names, whether it is isolated
 *             from other apps, which migrations ran, and that Prod has no backup yet; I never see a password.
 * ARCHITECTURE:
 *   - Workstream D's panel inside the Code and runs view (C2 places it; spec section 11 view 3). Talks only to
 *     `/api/apps/[id]/database` (GET view, POST create), the same functions as `get_app_database` /
 *     `create_app_database`. Shows names, states and the backup line; there is no credential to show.
 *   - Text: `software.appBuilder.database.*`.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormat, useServerMessage, useTranslations } from '@core/i18n/client';
import type { AppEnv } from '@tabs/software/lib/app-builder-contracts';
import type { AppDatabaseView } from '@tabs/software/lib/appdb/database';
import type { AppBuilderApp } from '@tabs/software/ui/app-builder/AppBuilderShell';

export default function DatabasePanel({ app, env }: { app: AppBuilderApp; env: AppEnv }) {
  const t = useTranslations('software');
  const f = useFormat();
  const serverMessage = useServerMessage();
  const [view, setView] = useState<AppDatabaseView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/apps/${encodeURIComponent(app.id)}/database`;

  const load = useCallback(async () => {
    setError('');
    const res = await fetch(`${base}?env=${env}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(serverMessage(body, t('appBuilder.database.loadFailed')));
      return;
    }
    setView(body as AppDatabaseView);
  }, [base, env, serverMessage, t]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError('');
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env }) });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(serverMessage(body, t('appBuilder.database.createFailed')));
      return;
    }
    setView(body as AppDatabaseView);
  }

  const envLabel = t(`appBuilder.shell.${env}`);
  const m = view?.record?.migrations;
  return (
    <section className="card" data-testid="app-builder-database">
      <h4>{t('appBuilder.database.title', { env: envLabel })}</h4>
      {error && <p role="alert" className="error">{error}</p>}
      {!view ? (
        <p className="muted">{t('appBuilder.database.loading')}</p>
      ) : !view.configured ? (
        <p className="muted">{t('appBuilder.database.notConfigured')}</p>
      ) : !view.record ? (
        <>
          <p className="muted">{t('appBuilder.database.none', { env: envLabel })}</p>
          <button type="button" disabled={busy} onClick={() => void create()}>
            {t('appBuilder.database.create')}
          </button>
        </>
      ) : (
        <dl>
          <dt>{t('appBuilder.database.name')}</dt>
          <dd><code>{view.connection?.database}</code></dd>
          <dt>{t('appBuilder.database.host')}</dt>
          <dd><code>{view.connection ? `${view.connection.host}:${view.connection.port}` : ''}</code></dd>
          <dt>{t('appBuilder.database.credential')}</dt>
          <dd>{t('appBuilder.database.credentialIn', { secret: view.connection?.secret ?? '' })}</dd>
          <dt>{t('appBuilder.database.isolation')}</dt>
          <dd>{t(`appBuilder.database.isolationStates.${view.isolation.state}`)}</dd>
          <dt>{t('appBuilder.database.migrations')}</dt>
          <dd>
            {m && m.applied.length ? m.applied.join(', ') : t('appBuilder.database.noMigrations')}
            {m?.lastRunAt ? ` · ${t(`appBuilder.database.migrationStatus.${m.status}`)} · ${f.relativeTime(m.lastRunAt)}` : ''}
          </dd>
          <dt>{t('appBuilder.database.backup')}</dt>
          <dd>{env === 'prod' ? <strong>{t('appBuilder.database.noBackup')}</strong> : t('appBuilder.database.noBackupDev')}</dd>
        </dl>
      )}
      {view?.problems.length ? <p className="muted">{t('appBuilder.database.problems', { count: view.problems.length })}</p> : null}
      <p className="muted">{t('appBuilder.database.forwardOnly')}</p>
    </section>
  );
}
