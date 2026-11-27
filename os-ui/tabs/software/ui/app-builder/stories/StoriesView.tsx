/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Stories view (epics, story cards, criteria, history, pending diff cards)
 * USER STORY: As a business user I want to see and edit my app's epics and user stories, each with its status and
 *             test light, and see who changed what.
 * ARCHITECTURE:
 *   - Spec section 11 view 1, workstream A. Reads GET /api/apps/[id]/stories (the living spec from git plus status and
 *     light per story) and saves through PUT on the same route (one save = one commit with the user as author and
 *     `OS-Source: ui`). Every save carries the spec sha the view was loaded at, so a save over someone else's newer
 *     version is refused (409) instead of overwriting it.
 *   - First open of an app whose epics still live only on the app record: an editor's view asks for the migration once
 *     (PUT op `migrate`, spec 3.4) and says what happened.
 *   - Status and light are text badges (colour is never the only signal); the editors are labelled forms; the outcome of
 *     every action is announced in a polite live region and failures in an alert.
 *   - Text: `software` namespace, `appBuilder.stories.*`, all seven locales. Server messages (validation issues) are shown
 *     as the server wrote them, like every typed error in the OS.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import type { AppBuilderViewProps } from '@tabs/software/ui/app-builder/AppBuilderShell';
import type { SpecIssue } from '@tabs/software/lib/app-builder-contracts';
import {
  epicBody,
  epicDraftOf,
  groupByEpic,
  newEpicDraft,
  newStoryDraft,
  storyBody,
  storyDraftOf,
  type EpicDraft,
  type SaveOutcome,
  type StoriesPayload,
  type StoryDraft,
} from '@tabs/software/ui/app-builder/stories/model';
import StoryCard from '@tabs/software/ui/app-builder/stories/StoryCard';
import StoryEditor from '@tabs/software/ui/app-builder/stories/StoryEditor';
import EpicEditor from '@tabs/software/ui/app-builder/stories/EpicEditor';
import HistoryPanel from '@tabs/software/ui/app-builder/stories/HistoryPanel';

type Editing = { kind: 'story'; draft: StoryDraft } | { kind: 'epic'; draft: EpicDraft } | null;

export default function StoriesView({ app }: AppBuilderViewProps) {
  const t = useTranslations('software');
  const [data, setData] = useState<StoriesPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const migrateAsked = useRef(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}/stories`, { cache: 'no-store' });
      const body = (await res.json()) as StoriesPayload & { error?: string };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      setData(body);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [app.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Spec 3.4: an editor's first open migrates the record-only epics into story files, once.
  useEffect(() => {
    if (!data || !data.canEdit || data.legacyEpics === 0 || migrateAsked.current) return;
    migrateAsked.current = true;
    setNotice(t('appBuilder.stories.migrating'));
    void (async () => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}/stories`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'migrate' }) });
        const body = (await res.json()) as { migrated?: boolean; stories?: number; error?: string };
        if (!res.ok) throw new Error(body.error ?? String(res.status));
        setNotice(body.migrated ? t('appBuilder.stories.migrated', { count: body.stories ?? 0 }) : '');
        await load();
      } catch (e) {
        setNotice('');
        setLoadError(t('appBuilder.stories.migrateFailed', { error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  }, [data, app.id, load, t]);

  const save = useCallback(
    async (body: unknown): Promise<SaveOutcome> => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}/stories`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const out = (await res.json()) as { sha?: string; changed?: boolean; error?: string; issues?: SpecIssue[] };
        if (res.status === 409) return { ok: false, error: t('appBuilder.stories.form.conflict') };
        if (!res.ok) return { ok: false, error: out.error ?? String(res.status), issues: out.issues };
        setNotice(out.changed ? t('appBuilder.stories.form.saved', { sha: String(out.sha ?? '').slice(0, 12) }) : t('appBuilder.stories.form.unchanged'));
        setEditing(null);
        await load();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [app.id, load, t],
  );

  if (loadError && !data) {
    return (
      <div className="card" data-testid="app-builder-stories">
        <h3>{t('appBuilder.stories.title')}</h3>
        <p className="error" role="alert">{t('appBuilder.stories.loadFailed', { error: loadError })}</p>
        <button type="button" className="btn sm" onClick={() => void load()}>{t('appBuilder.stories.reload')}</button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card" data-testid="app-builder-stories" aria-busy="true">
        <h3>{t('appBuilder.stories.title')}</h3>
        <p className="muted" role="status">{t('appBuilder.stories.loading')}</p>
      </div>
    );
  }

  const groups = groupByEpic(data);
  const editingStory = editing?.kind === 'story' ? editing.draft : null;
  const editingEpic = editing?.kind === 'epic' ? editing.draft : null;

  return (
    <div className="card" data-testid="app-builder-stories">
      <header className="row" style={{ alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{t('appBuilder.stories.title')}</h3>
        {data.sha ? <span className="muted mono">{t('appBuilder.stories.version', { sha: data.sha.slice(0, 12) })}</span> : null}
        {data.canEdit ? (
          <button type="button" className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setEditing({ kind: 'epic', draft: newEpicDraft() })} disabled={editing !== null}>
            {t('appBuilder.stories.addEpic')}
          </button>
        ) : null}
      </header>
      <p className="hint">{t('appBuilder.stories.intro', { app: app.name })}</p>
      <p role="status" aria-live="polite" className="muted">{notice}</p>
      {loadError ? <p className="error" role="alert">{loadError}</p> : null}
      {data.truncated ? <p className="error" role="alert">{t('appBuilder.stories.truncated')}</p> : null}
      {data.issues.length > 0 ? (
        <details className="error">
          <summary>{t('appBuilder.stories.issuesTitle', { count: data.issues.length })}</summary>
          <ul>
            {data.issues.map((i, n) => (
              <li key={`${i.path}-${n}`} className="mono">
                {i.path}
                {i.line !== undefined ? `:${i.line}` : ''} {i.reason}. {i.fix}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editingEpic && !editingEpic.id ? (
        <EpicEditor draft={editingEpic} onCancel={() => setEditing(null)} onSave={(d) => save(epicBody(d, data.sha))} />
      ) : null}

      {groups.length === 0 && !editingEpic ? <p className="muted">{data.canEdit ? t('appBuilder.stories.empty') : t('appBuilder.stories.emptyReadOnly')}</p> : null}

      {groups.map(({ epic, stories }) => {
        const headingId = `epic-${app.id}-${epic.id}`;
        const epicEditing = editingEpic?.id === epic.id;
        return (
          <section key={epic.id} aria-labelledby={headingId} style={{ marginTop: 20 }}>
            <div className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <h4 id={headingId} style={{ margin: 0 }}>
                <span className="mono">{epic.id}</span> {epic.title}
              </h4>
              <button type="button" className="btn ghost sm" aria-expanded={historyId === epic.id} onClick={() => setHistoryId(historyId === epic.id ? null : epic.id)}>
                {historyId === epic.id ? t('appBuilder.stories.hideHistory') : t('appBuilder.stories.history')}
              </button>
              {data.canEdit ? (
                <>
                  <button type="button" className="btn ghost sm" disabled={editing !== null} onClick={() => setEditing({ kind: 'epic', draft: epicDraftOf(epic) })}>
                    {t('appBuilder.stories.editEpic')}
                  </button>
                  <button type="button" className="btn ghost sm" disabled={editing !== null} onClick={() => setEditing({ kind: 'story', draft: newStoryDraft(epic.id) })}>
                    {t('appBuilder.stories.addStory')}
                  </button>
                </>
              ) : null}
            </div>
            {historyId === epic.id ? <HistoryPanel appId={app.id} id={epic.id} /> : null}
            {epicEditing && editingEpic ? (
              <EpicEditor draft={editingEpic} onCancel={() => setEditing(null)} onSave={(d) => save(epicBody(d, data.sha))} />
            ) : (
              <>
                {epic.description ? <p style={{ whiteSpace: 'pre-wrap' }}>{epic.description}</p> : null}
                {epic.requirements.technical || epic.requirements.ux || epic.requirements.governance ? (
                  <dl className="hint">
                    {(['technical', 'ux', 'governance'] as const)
                      .filter((k) => epic.requirements[k])
                      .map((k) => (
                        <div key={k}>
                          <dt>{t(`appBuilder.stories.${k}`)}</dt>
                          <dd style={{ whiteSpace: 'pre-wrap' }}>{epic.requirements[k]}</dd>
                        </div>
                      ))}
                  </dl>
                ) : null}
              </>
            )}
            {editingStory && !editingStory.id && editingStory.epic === epic.id ? (
              <StoryEditor draft={editingStory} epics={data.epics} onCancel={() => setEditing(null)} onSave={(d) => save(storyBody(d, data.sha))} />
            ) : null}
            {stories.length === 0 && !(editingStory && editingStory.epic === epic.id) ? <p className="muted">{t('appBuilder.stories.noStories')}</p> : null}
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {stories.map((s) => (
                <li key={s.id} style={{ marginTop: 12 }}>
                  {editingStory?.id === s.id ? (
                    <StoryEditor draft={editingStory} epics={data.epics} onCancel={() => setEditing(null)} onSave={(d) => save(storyBody(d, data.sha))} />
                  ) : (
                    <StoryCard
                      story={s}
                      canEdit={data.canEdit && editing === null}
                      historyOpen={historyId === s.id}
                      onEdit={() => setEditing({ kind: 'story', draft: storyDraftOf(s) })}
                      onToggleHistory={() => setHistoryId(historyId === s.id ? null : s.id)}
                    />
                  )}
                  {historyId === s.id ? <HistoryPanel appId={app.id} id={s.id} /> : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
