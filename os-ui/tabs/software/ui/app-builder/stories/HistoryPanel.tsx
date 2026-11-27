/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder A - the version history of one epic or story: who, when, from where, and the diff
 * USER STORY: As a business user I want to see every version of a story with its author, time and source, and the exact
 *             lines that changed.
 * ARCHITECTURE: Reads GET /api/apps/[id]/stories/[sid]/history. Each version is a list item with author, local time
 *             (useFormat), source and, when an approved diff card caused it, the card id; the diff is rendered line by
 *             line with its +/- prefix kept, so additions and removals do not rely on colour alone.
 */
'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useFormat, useTranslations } from '@core/i18n/client';
import { diffLines, type HistoryPayload } from '@tabs/software/ui/app-builder/stories/model';

const LINE_STYLE: Record<string, CSSProperties> = {
  add: { background: 'color-mix(in srgb, var(--ok, #2e7d32) 14%, transparent)' },
  del: { background: 'color-mix(in srgb, var(--err, #c62828) 14%, transparent)' },
  hunk: { opacity: 0.7 },
  meta: { opacity: 0.7 },
  ctx: {},
};

export default function HistoryPanel({ appId, id }: { appId: string; id: string }) {
  const t = useTranslations('software');
  const f = useFormat();
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/stories/${encodeURIComponent(id)}/history`, { cache: 'no-store' });
        const body = (await res.json()) as HistoryPayload & { error?: string };
        if (!res.ok) throw new Error(body.error ?? String(res.status));
        if (live) setData(body);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [appId, id]);

  return (
    <section className="card" aria-label={t('appBuilder.stories.historyTitle', { id })} style={{ marginTop: 8 }}>
      <h6 style={{ margin: '0 0 8px', fontSize: '0.9rem' }}>{t('appBuilder.stories.historyTitle', { id })}</h6>
      {error ? <p className="error" role="alert">{t('appBuilder.stories.historyFailed', { error })}</p> : null}
      {!data && !error ? <p className="muted" role="status">{t('appBuilder.stories.historyLoading')}</p> : null}
      {data && data.versions.length === 0 ? <p className="muted">{t('appBuilder.stories.historyEmpty')}</p> : null}
      {data && data.versions.length > 0 ? (
        <ol style={{ paddingLeft: 18 }}>
          {data.versions.map((v) => (
            <li key={v.sha} style={{ marginBottom: 12 }}>
              <div>
                {t('appBuilder.stories.versionBy', { author: v.author.name, when: f.dateTime(v.at), source: t(`appBuilder.stories.source.${v.source}`) })}
                {v.proposalId ? <span className="badge muted" style={{ marginLeft: 6 }}>{t('appBuilder.stories.proposal', { id: v.proposalId })}</span> : null}
                <span className="muted mono" style={{ marginLeft: 6 }}>{v.sha.slice(0, 12)}</span>
              </div>
              <details>
                <summary>{t('appBuilder.stories.diffLabel', { sha: v.sha.slice(0, 12) })}</summary>
                <pre className="mono" style={{ overflowX: 'auto', fontSize: '0.8rem', margin: '4px 0' }}>
                  {diffLines(v.diff).map((l, i) => (
                    <div key={i} style={LINE_STYLE[l.kind]}>
                      {l.text}
                    </div>
                  ))}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
