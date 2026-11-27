/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (C2) - the app's own logs per env and preview slot, redacted by the server
 * USER STORY: As an app builder I read the last lines my app printed in Dev, a preview slot or Prod.
 * ARCHITECTURE:
 *   - Talks only to GET /api/apps/[id]/logs (editors only; the server selects the app's own pods and redacts secrets
 *     and tokens before anything leaves os-ui). The page never stores the text beyond this panel's state.
 *   - Text: `software.appBuilder.runs.logs.*`.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useServerMessage, useTranslations } from '@core/i18n/client';
import type { AppEnv, PreviewSlot } from '@tabs/software/lib/app-builder-contracts';
import type { AppLogsView } from '@tabs/software/lib/releases/logs';
import type { AppBuilderApp } from '@tabs/software/ui/app-builder/AppBuilderShell';

const TAILS = [100, 200, 500, 1000] as const;

export default function LogsPanel({ app, env }: { app: AppBuilderApp; env: AppEnv }) {
  const t = useTranslations('software');
  const serverMessage = useServerMessage();
  const [slot, setSlot] = useState<'' | PreviewSlot>('');
  const [tail, setTail] = useState<number>(200);
  const [view, setView] = useState<AppLogsView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    const q = new URLSearchParams({ env, tail: String(tail) });
    if (env === 'dev' && slot) q.set('slot', slot);
    const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}/logs?${q.toString()}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setView(null);
      setError(serverMessage(body, t('appBuilder.runs.logs.loadFailed')));
      return;
    }
    setView(body as AppLogsView);
  }, [app.id, env, slot, tail, serverMessage, t]);

  useEffect(() => {
    if (env !== 'dev') setSlot('');
  }, [env]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="card" data-testid="app-builder-logs">
      <h4>{t('appBuilder.runs.logs.title', { env: t(`appBuilder.shell.${env}`) })}</h4>
      <p className="muted">{t('appBuilder.runs.logs.intro')}</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        {env === 'dev' && (
          <label>
            {t('appBuilder.runs.logs.source')}
            <select value={slot} onChange={(e) => setSlot(e.target.value as '' | PreviewSlot)}>
              <option value="">{t('appBuilder.runs.logs.sourceEnv')}</option>
              <option value="p1">{t('appBuilder.runs.previews.slot', { slot: 'p1' })}</option>
              <option value="p2">{t('appBuilder.runs.previews.slot', { slot: 'p2' })}</option>
            </select>
          </label>
        )}
        <label>
          {t('appBuilder.runs.logs.tail')}
          <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
            {TAILS.map((n) => (
              <option key={n} value={n}>{t('appBuilder.runs.logs.lines', { count: n })}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void load()} disabled={busy}>
          {t('appBuilder.runs.logs.refresh')}
        </button>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      {view?.problem && <p className="muted">{t('appBuilder.runs.logs.problem', { problem: view.problem })}</p>}
      {view?.truncated && <p className="muted">{t('appBuilder.runs.logs.truncated')}</p>}
      {view && view.text && (
        <pre aria-label={t('appBuilder.runs.logs.textLabel')} style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {view.text}
        </pre>
      )}
    </section>
  );
}
