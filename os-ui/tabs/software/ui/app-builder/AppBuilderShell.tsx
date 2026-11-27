/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder (W0) - the three-view shell a `nextjs-web@2` app opens in (Stories | Chat | Code and runs)
 * USER STORY: As an app builder I want my app to open on its user stories, with the build chat and the code, runs and
 *             releases one click away, and one switch between the Dev and the Prod environment.
 * ARCHITECTURE:
 *   - Spec section 11. Rendered by SoftwareBuilder ONLY for a `templateVersion: 2` app while the App Builder flag is
 *     on (the page receives the flag from GET /api/apps/[id]); every other app keeps today's builder unchanged.
 *   - W0 ships the frame and three placeholder views; workstream A owns `stories/`, B `chat/`, C2 (with D's panels)
 *     `runs/`. Each view receives the app and the selected env; the shell holds no data of its own.
 *   - Text from the `software` namespace (`appBuilder.*`), all seven locales.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import type { AppEnv } from '@tabs/software/lib/app-builder-contracts';
import StoriesView from '@tabs/software/ui/app-builder/stories/StoriesView';
import ChatView from '@tabs/software/ui/app-builder/chat/ChatView';
import RunsView from '@tabs/software/ui/app-builder/runs/RunsView';

export type AppBuilderView = 'stories' | 'chat' | 'runs';
export const APP_BUILDER_VIEWS: readonly AppBuilderView[] = ['stories', 'chat', 'runs'];

/** The fields every view may rely on (a subset of the app record the page already loads). */
export type AppBuilderApp = { id: string; slug: string; name: string; domain: string; templateVersion?: 1 | 2 };

export type AppBuilderViewProps = { app: AppBuilderApp; env: AppEnv; onReload: () => void };

export default function AppBuilderShell({ app, onReload }: { app: AppBuilderApp; onReload: () => void }) {
  const t = useTranslations('software');
  const [view, setView] = useState<AppBuilderView>('stories');
  const [env, setEnv] = useState<AppEnv>('dev');
  const props: AppBuilderViewProps = { app, env, onReload };
  return (
    <section className="app-builder" data-testid="app-builder-shell">
      <header className="row" style={{ alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('appBuilder.shell.title')}</h2>
        <div className="seg" role="tablist" aria-label={t('appBuilder.shell.views')}>
          {APP_BUILDER_VIEWS.map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {t(`appBuilder.shell.${v}`)}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t('appBuilder.shell.env')} style={{ marginLeft: 'auto' }}>
          {(['dev', 'prod'] as const).map((e) => (
            <button key={e} type="button" aria-pressed={env === e} className={env === e ? 'on' : ''} onClick={() => setEnv(e)}>
              {t(`appBuilder.shell.${e}`)}
            </button>
          ))}
        </div>
      </header>
      {view === 'stories' ? <StoriesView {...props} /> : view === 'chat' ? <ChatView {...props} /> : <RunsView {...props} />}
    </section>
  );
}
