/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        governance
 * FEATURE:    Governance → Repositories — the domain repositories, their heads and their mirrors
 * USER STORY: As an operator I want one screen that proves "everything built in the OS lives in
 *             git": every domain repository with its head, commit count, last author and mirror
 *             health, plus the layout table saying which object kinds are in git today and which
 *             are not (checklist G10).
 * ARCHITECTURE:
 *   - A SHELL over `tabs/governance/lib/repositories.ts` (every verdict and every string) and
 *     `/api/git?action=repos`, which is `repoSummaries()` plus the EXISTING `git-mirror` health
 *     record — one health source, not a second one.
 *   - Honest by construction: a mirror that last pushed an older commit reads "behind", a failed
 *     push shows its real error, and a kind with no writer is listed as "not in git yet".
 */
'use client';

import { useCallback, useState } from 'react';
import { useApi } from '@core/ui/useApi';
import { useTranslations, useFormat } from '@core/i18n/client';
import {
  repoViews,
  repoSummaryMessage,
  mirrorBadgeClass,
  layoutViews,
  repoCommitViews,
  mirrorLink,
  type RepoRow,
  type LayoutRow,
  type RepoCommit,
  type RepoCommitView,
  type GovMessage,
} from '@tabs/governance/lib/repositories';

/** `toLocaleString()`'s English form, kept byte-identical; other locales get their own. */
const LEGACY_DT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

const MIRROR_KEYS = { ok: 'repos.mirror.ok', behind: 'repos.mirror.behind', failed: 'repos.mirror.failed', none: 'repos.mirror.none' } as const;

export default function RepositoriesView() {
  const t = useTranslations('governance');
  const f = useFormat();
  const msg = (m: GovMessage) => t(m.key as Parameters<typeof t>[0], m.args);
  const { data, loading, error } = useApi<{ repos: RepoRow[]; layout: LayoutRow[] }>('/api/git?action=repos');
  const [openLog, setOpenLog] = useState<string>('');
  const [commits, setCommits] = useState<Record<string, RepoCommitView[]>>({});
  const [logNote, setLogNote] = useState<Record<string, string>>({});
  const [logError, setLogError] = useState('');

  // The commit log of ONE repository, loaded on demand: subjects, authors and trailers only.
  const toggleLog = useCallback(
    async (domain: string) => {
      setLogError('');
      if (openLog === domain) {
        setOpenLog('');
        return;
      }
      setOpenLog(domain);
      if (commits[domain]) return;
      try {
        const res = await fetch(`/api/git?action=repolog&domain=${encodeURIComponent(domain)}`, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) setLogError(body.error ?? t('repos.logFailed', { status: res.status }));
        else {
          setCommits((prev) => ({ ...prev, [domain]: repoCommitViews((body.commits ?? []) as RepoCommit[]) }));
          // The server says how many rows it withheld and why (review H-2) — show that, never a
          // quietly shorter list.
          setLogNote((prev) => ({ ...prev, [domain]: String(body.note ?? '') }));
        }
      } catch (e) {
        setLogError((e as Error).message);
      }
    },
    [openLog, commits, t],
  );

  if (loading) return <div className="muted">{t('repos.loading')}</div>;
  if (error) return <div className="error">{error}</div>;
  const repos = data?.repos ?? [];
  const rows = repoViews(repos);
  const layout = layoutViews(data?.layout ?? []);
  return (
    <>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        <b>{msg(repoSummaryMessage(repos))}</b>
      </p>

      {rows.length > 0 ? (
        <table className="tbl" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>{t('repos.th.domain')}</th>
              <th>{t('repos.th.head')}</th>
              <th>{t('repos.th.commits')}</th>
              <th>{t('repos.th.lastCommit')}</th>
              <th>{t('repos.th.mirror')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.domain}>
                <td>
                  <span className="mono">{r.domain}</span>
                  <div className="muted mono" style={{ fontSize: 11 }} title={t('repos.cloneTitle')}>{r.cloneHint}</div>
                </td>
                <td className="mono">{r.head}</td>
                <td>{r.commits}</td>
                <td>
                  {r.lastAuthor}
                  {r.lastAt ? <span className="muted" style={{ fontSize: 11 }}> · {f.dateTime(r.lastAt, LEGACY_DT)}</span> : null}
                  <div className="muted" style={{ fontSize: 11, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.lastSubject}>
                    {r.lastSubject}
                  </div>
                </td>
                <td>
                  <span className={`badge ${mirrorBadgeClass(r.mirror)}`}>{t(MIRROR_KEYS[r.mirror])}</span>
                  <div className="muted" style={{ fontSize: 11, maxWidth: 420 }}>{msg(r.mirrorDetailMsg)}</div>
                  {mirrorLink(repos.find((x) => x.domain === r.domain)?.mirror?.url) ? (
                    <a
                      href={mirrorLink(repos.find((x) => x.domain === r.domain)!.mirror!.url)!}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ fontSize: 11 }}
                    >
                      {t('repos.openMirror')}
                    </a>
                  ) : null}
                  <div>
                    <button className="btn ghost sm" style={{ fontSize: 11, marginTop: 4 }} onClick={() => void toggleLog(r.domain)}>
                      {openLog === r.domain ? t('repos.hideLog') : t('repos.showLog')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {openLog && commits[openLog] ? (
              <tr>
                <td colSpan={5}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                    {t('repos.logHeader', { domain: openLog, count: commits[openLog].length })}
                    {logNote[openLog] ? <> {logNote[openLog]}</> : null}
                  </div>
                  <table className="tbl" style={{ fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th>{t('repos.log.commit')}</th>
                        <th>{t('repos.log.action')}</th>
                        <th>{t('repos.log.object')}</th>
                        <th>{t('repos.log.by')}</th>
                        <th>{t('repos.log.from')}</th>
                        <th>{t('repos.log.when')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commits[openLog].map((c) => (
                        <tr key={c.sha}>
                          <td className="mono" title={c.sha}>{c.short}</td>
                          <td>
                            {c.action}
                            {c.platform ? <span className="badge" style={{ marginLeft: 6, fontSize: 10 }}>{t('repos.log.catchUp')}</span> : null}
                          </td>
                          <td className="mono">{c.object}</td>
                          <td>{c.author}</td>
                          <td className="mono">{c.surface}</td>
                          <td>{f.dateTime(c.at, LEGACY_DT)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </td>
              </tr>
            ) : null}
            {logError ? (
              <tr>
                <td colSpan={5}><span className="error">{logError}</span></td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : null}

      <h3 style={{ fontSize: 14, margin: '22px 0 6px' }}>{t('repos.layout.title')}</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        {t.rich('repos.layout.intro', { path: 'docs/components/git.md', mono: (c) => <span className="mono">{c}</span> })}
      </p>
      <table className="tbl" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>{t('repos.layout.th.object')}</th>
            <th>{t('repos.layout.th.path')}</th>
            <th>{t('repos.layout.th.personalLane')}</th>
            <th>{t('repos.layout.th.inGit')}</th>
          </tr>
        </thead>
        <tbody>
          {layout.map((l) => (
            <tr key={l.kind}>
              <td>
                {l.label}
                <div className="muted mono" style={{ fontSize: 11 }}>{l.kind}</div>
              </td>
              <td className="mono">{l.paths}</td>
              <td className="mono">{l.personalLane}</td>
              <td>
                <span className={`badge ${l.status === 'in git' ? 'ok' : l.status === 'landing' ? 'warn' : ''}`}>{t(l.statusKey)}</span>
                <div className="muted" style={{ fontSize: 11, maxWidth: 380 }}>{l.detailMsg ? msg(l.detailMsg) : l.detail}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
