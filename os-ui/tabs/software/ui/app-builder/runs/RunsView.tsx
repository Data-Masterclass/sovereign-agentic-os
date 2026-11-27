/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the Code and runs view (runs, releases per env, previews, go-live, rollback, logs, env and
 *             database panels)
 * USER STORY: As an app builder I want to see every run, which release serves Dev, each preview and Prod, take Dev live
 *             in Prod under the go-live rules, roll back, read my app's logs, set env and secrets, and see my database.
 * ARCHITECTURE:
 *   - Workstream C2 owns this folder (spec section 11 view 3); D's `EnvPanel` and `DatabasePanel` are mounted here.
 *   - Talks only to C2's routes: GET/POST /api/apps/[id]/releases (read model `ReleasesView`, go-live, decide), GET/POST
 *     /api/apps/[id]/rollback, and the logs panel's GET /api/apps/[id]/logs. Every rule is the server's; the buttons only
 *     mirror `goLive.ok` / `rollback.possible`, and every refusal is shown in the user's language.
 *   - Text: `software.appBuilder.runs.*`.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormat, useServerMessage, useTranslations } from '@core/i18n/client';
import type { AppEnv } from '@tabs/software/lib/app-builder-contracts';
import type { ReleaseView, ReleasesView } from '@tabs/software/lib/releases/view';
import type { RollbackPlan } from '@tabs/software/lib/releases/rollback';
import type { AppBuilderViewProps } from '@tabs/software/ui/app-builder/AppBuilderShell';
import EnvPanel from '@tabs/software/ui/app-builder/runs/EnvPanel';
import DatabasePanel from '@tabs/software/ui/app-builder/runs/DatabasePanel';
import LogsPanel from '@tabs/software/ui/app-builder/runs/LogsPanel';

const short = (s: string | null | undefined, n = 12) => (s ? s.replace(/^sha256:/, '').slice(0, n) : '');

export default function RunsView({ app, env, onReload }: AppBuilderViewProps) {
  const t = useTranslations('software');
  const f = useFormat();
  const serverMessage = useServerMessage();
  const [view, setView] = useState<ReleasesView | null>(null);
  const [plan, setPlan] = useState<RollbackPlan | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const base = `/api/apps/${encodeURIComponent(app.id)}`;
  const envLabel = t(`appBuilder.shell.${env}`);

  const load = useCallback(async () => {
    setError('');
    const res = await fetch(`${base}/releases?env=${env}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setView(null);
      setError(serverMessage(body, t('appBuilder.runs.loadFailed')));
      return;
    }
    setView(body as ReleasesView);
    const rb = await fetch(`${base}/rollback?env=${env}`, { cache: 'no-store' });
    const rbBody = (await rb.json().catch(() => ({}))) as { plan?: RollbackPlan | null };
    setPlan(rb.ok ? rbBody.plan ?? null : null);
  }, [base, env, serverMessage, t]);

  useEffect(() => {
    setNotice('');
    void load();
  }, [load]);

  async function post(path: string, payload: unknown, fallback: string, ok: (body: Record<string, unknown>) => string) {
    setBusy(true);
    setError('');
    setNotice('');
    const res = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(false);
    if (!res.ok) {
      setError(serverMessage(body, fallback));
      return;
    }
    setNotice(ok(body));
    void load();
    onReload();
  }

  const goLive = () =>
    post('releases', { action: 'go-live' }, t('appBuilder.runs.goLive.failed'), (b) => (b.kind === 'review' ? t('appBuilder.runs.goLive.requested') : t('appBuilder.runs.goLive.done')));
  const decide = (cardId: string, decision: 'approve' | 'deny') =>
    post('releases', { action: 'decide', cardId, decision }, t('appBuilder.runs.goLive.decideFailed'), () => (decision === 'approve' ? t('appBuilder.runs.goLive.approved') : t('appBuilder.runs.goLive.denied')));
  const rollback = () => post('rollback', { env }, t('appBuilder.runs.rollback.failed'), () => t('appBuilder.runs.rollback.done', { env: envLabel }));

  const releaseRow = (r: ReleaseView) => (
    <tr key={r.id}>
      <td><code>{r.id}</code></td>
      <td><code title={r.sha}>{short(r.sha)}</code></td>
      <td><code title={r.digest}>{short(r.digest)}</code></td>
      <td>{t(`appBuilder.runs.states.${r.state}`)}</td>
      <td>{r.migrations.applied.length ? r.migrations.applied.join(', ') : t(`appBuilder.runs.migrations.${r.migrations.status}`)}</td>
      <td className="muted">{t('appBuilder.runs.byWhen', { who: r.by, when: f.relativeTime(r.at) })}</td>
      <td>{r.url ? <a href={r.url} target="_blank" rel="noreferrer">{t('appBuilder.runs.open')}</a> : null}</td>
    </tr>
  );

  return (
    <div className="stack" data-testid="app-builder-runs" style={{ display: 'grid', gap: 12 }}>
      <section className="card">
        <h3>{t('appBuilder.runs.title')}</h3>
        {error && <p role="alert" className="error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!view && !error && <p className="muted">{t('appBuilder.runs.loading')}</p>}
        {view && !view.builder.configured && (
          <div role="note" className="notice">
            <p><strong>{t('appBuilder.runs.noBuilder')}</strong></p>
            {view.builder.reason && <p className="muted">{view.builder.reason}</p>}
          </div>
        )}
        {view?.needsRebuild && (
          <div role="note" className="notice">
            <p><strong>{t('appBuilder.runs.needsRebuild.title')}</strong></p>
            <p className="muted">{t('appBuilder.runs.needsRebuild.body', { reason: view.needsRebuild.reason })}</p>
          </div>
        )}
        {view && (
          <dl className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <div>
              <dt>{t('appBuilder.runs.urls.dev')}</dt>
              <dd>{view.urls.dev ? <a href={view.urls.dev} target="_blank" rel="noreferrer">{view.urls.dev}</a> : <span className="muted">{t('appBuilder.runs.urls.none')}</span>}</dd>
            </div>
            <div>
              <dt>{t('appBuilder.runs.urls.prod')}</dt>
              <dd>{view.urls.prod ? <a href={view.urls.prod} target="_blank" rel="noreferrer">{view.urls.prod}</a> : <span className="muted">{t('appBuilder.runs.urls.none')}</span>}</dd>
            </div>
          </dl>
        )}
      </section>

      {view && (
        <section className="card" aria-labelledby="ab-releases">
          <h4 id="ab-releases">{t('appBuilder.runs.releases.title', { env: envLabel })}</h4>
          {view.current ? (
            <p>{t('appBuilder.runs.releases.current', { id: view.current.id, sha: short(view.current.sha) })}</p>
          ) : (
            <p className="muted">{t('appBuilder.runs.releases.none', { env: envLabel })}</p>
          )}
          {view.releases.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{t('appBuilder.runs.releases.id')}</th>
                  <th>{t('appBuilder.runs.releases.commit')}</th>
                  <th>{t('appBuilder.runs.releases.digest')}</th>
                  <th>{t('appBuilder.runs.releases.state')}</th>
                  <th>{t('appBuilder.runs.releases.migrations')}</th>
                  <th>{t('appBuilder.runs.releases.when')}</th>
                  <th aria-label={t('appBuilder.runs.releases.link')} />
                </tr>
              </thead>
              <tbody>{view.releases.map(releaseRow)}</tbody>
            </table>
          )}

          {env === 'dev' && (
            <div aria-label={t('appBuilder.runs.goLive.title')}>
              <h4>{t('appBuilder.runs.goLive.title')}</h4>
              <p className="muted">{t('appBuilder.runs.goLive.rule', { scope: t(`appBuilder.runs.scopes.${view.goLive.scope as 'my' | 'domain' | 'company'}`), reviewer: t(`appBuilder.runs.reviewers.${view.goLive.reviewer as 'none' | 'builder' | 'domain_admin' | 'admin'}`) })}</p>
              {view.goLive.pendingCardId ? (
                <div>
                  <p>{t('appBuilder.runs.goLive.pending')}</p>
                  <button type="button" disabled={busy} onClick={() => void decide(view.goLive.pendingCardId as string, 'approve')}>{t('appBuilder.runs.goLive.approve')}</button>{' '}
                  <button type="button" disabled={busy} onClick={() => void decide(view.goLive.pendingCardId as string, 'deny')}>{t('appBuilder.runs.goLive.deny')}</button>
                  <p className="muted">{t('appBuilder.runs.goLive.noSelfApproval')}</p>
                </div>
              ) : (
                <>
                  <button type="button" disabled={busy || !view.goLive.ok} onClick={() => void goLive()} aria-describedby={view.goLive.ok ? undefined : 'ab-golive-why'}>
                    {t('appBuilder.runs.goLive.button')}
                  </button>
                  {!view.goLive.ok && view.goLive.reason && <p id="ab-golive-why" className="muted">{t('appBuilder.runs.goLive.blocked', { reason: view.goLive.reason })}</p>}
                  {view.goLive.noReviewer && (
                    <div role="note" className="notice" data-testid="ab-golive-no-reviewer">
                      <p><strong>{t('appBuilder.runs.goLive.noReviewer')}</strong></p>
                    </div>
                  )}
                  {view.goLive.reviewersUnchecked && <p className="muted">{t('appBuilder.runs.goLive.reviewersUnchecked')}</p>}
                </>
              )}
            </div>
          )}

          <div aria-label={t('appBuilder.runs.rollback.title')}>
            <h4>{t('appBuilder.runs.rollback.title')}</h4>
            {plan ? (
              <>
                <p>{t('appBuilder.runs.rollback.plan', { current: plan.current.id, target: plan.target.id, sha: short(plan.target.sha) })}</p>
                {plan.migrationsSince.length > 0 ? (
                  <p>{t('appBuilder.runs.rollback.migrations', { list: plan.migrationsSince.join(', ') })}</p>
                ) : (
                  <p className="muted">{t('appBuilder.runs.rollback.noMigrations')}</p>
                )}
                <p className="muted">{t('appBuilder.runs.rollback.warning')}</p>
                {env === 'prod' && <p className="muted">{t('appBuilder.runs.rollback.prodRight')}</p>}
                <button type="button" disabled={busy} onClick={() => void rollback()}>{t('appBuilder.runs.rollback.confirm', { env: envLabel })}</button>
              </>
            ) : (
              <p className="muted">{t('appBuilder.runs.rollback.none', { env: envLabel })}</p>
            )}
          </div>
        </section>
      )}

      {view && env === 'dev' && (
        <section className="card" aria-labelledby="ab-previews">
          <h4 id="ab-previews">{t('appBuilder.runs.previews.title')}</h4>
          <p className="muted">{t('appBuilder.runs.previews.intro')}</p>
          <ul>
            {view.previews.map((p) => (
              <li key={p.slot}>
                <strong>{t('appBuilder.runs.previews.slot', { slot: p.slot })}</strong>{' '}
                {p.sha ? (
                  <>
                    <code title={p.sha}>{short(p.sha)}</code>{' '}
                    {p.url && <a href={p.url} target="_blank" rel="noreferrer">{p.url}</a>}{' '}
                    <span className="muted">
                      {p.status?.phase === 'stopped' ? t('appBuilder.runs.previews.stopped') : p.idle ? t('appBuilder.runs.previews.idle') : p.status ? t(`appBuilder.runs.phases.${p.status.phase}`) : ''}
                    </span>
                  </>
                ) : (
                  <span className="muted">{t('appBuilder.runs.previews.empty')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view && (
        <section className="card" aria-labelledby="ab-runs">
          <h4 id="ab-runs">{t('appBuilder.runs.list.title')}</h4>
          {view.runs.length === 0 ? (
            <p className="muted">{t('appBuilder.runs.list.empty')}</p>
          ) : (
            <ul>
              {view.runs.map((r) => (
                <li key={`${r.sha}-${r.runRef ?? ''}`}>
                  <code title={r.sha}>{short(r.sha)}</code>{' '}
                  <strong>{r.status !== 'finished' ? t(`appBuilder.runs.list.status.${r.status}`) : r.green ? t('appBuilder.runs.list.green') : t('appBuilder.runs.list.red')}</strong>{' '}
                  {r.storyless && <span className="badge">{t('appBuilder.runs.list.storyless')}</span>}{' '}
                  {r.criteria && <span className="muted">{t('appBuilder.runs.list.criteria', { pass: r.criteria.pass, fail: r.criteria.fail })}</span>}{' '}
                  {r.digest && <span className="muted">{t('appBuilder.runs.list.digest', { digest: short(r.digest) })}</span>}
                  <span className="muted"> · {f.relativeTime(r.startedAt)}</span>
                  {r.steps.length > 0 && (
                    <ul className="row" aria-label={t('appBuilder.runs.list.steps')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', listStyle: 'none', padding: 0 }}>
                      {r.steps.map((s) => (
                        <li key={s.id} className={`chip ${s.status}`}>{t('appBuilder.runs.list.step', { id: s.id, status: t(`appBuilder.runs.list.stepStatus.${s.status as 'pass' | 'fail' | 'unavailable'}`) })}</li>
                      ))}
                    </ul>
                  )}
                  {r.status === 'finished' && !r.green && <p className="muted">{r.reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <LogsPanel app={app} env={env} />
      <EnvPanel app={app} env={env} />
      <DatabasePanel app={app} env={env} />
    </div>
  );
}
