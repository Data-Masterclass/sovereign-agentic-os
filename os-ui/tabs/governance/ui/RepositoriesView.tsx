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
import {
  repoViews,
  repoSummaryLine,
  mirrorBadgeClass,
  layoutViews,
  repoCommitViews,
  mirrorLink,
  type RepoRow,
  type LayoutRow,
  type RepoCommit,
  type RepoCommitView,
} from '@tabs/governance/lib/repositories';

export default function RepositoriesView() {
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
        if (!res.ok) setLogError(body.error ?? `Could not read the log (${res.status})`);
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
    [openLog, commits],
  );

  if (loading) return <div className="muted">Reading the domain repositories …</div>;
  if (error) return <div className="error">{error}</div>;
  const repos = data?.repos ?? [];
  const rows = repoViews(repos);
  const layout = layoutViews(data?.layout ?? []);
  return (
    <>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        One bare git repository per domain, written in-process by the OS as the person who made each
        change. Read access needs nothing but access to the domain — including the OS-owned{' '}
        <span className="mono">os/</span> metadata, which is committed as real files so nothing is a
        black box. <b>{repoSummaryLine(repos)}</b>
      </p>

      {rows.length > 0 ? (
        <table className="tbl" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Head</th>
              <th>Commits</th>
              <th>Last commit</th>
              <th>Mirror</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.domain}>
                <td>
                  <span className="mono">{r.domain}</span>
                  <div className="muted mono" style={{ fontSize: 11 }} title="Read-only clone, from inside the cluster">{r.cloneHint}</div>
                </td>
                <td className="mono">{r.head}</td>
                <td>{r.commits}</td>
                <td>
                  {r.lastAuthor}
                  {r.lastAt ? <span className="muted" style={{ fontSize: 11 }}> · {new Date(r.lastAt).toLocaleString()}</span> : null}
                  <div className="muted" style={{ fontSize: 11, maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.lastSubject}>
                    {r.lastSubject}
                  </div>
                </td>
                <td>
                  <span className={`badge ${mirrorBadgeClass(r.mirror)}`}>{r.mirror}</span>
                  <div className="muted" style={{ fontSize: 11, maxWidth: 420 }}>{r.mirrorDetail}</div>
                  {mirrorLink(repos.find((x) => x.domain === r.domain)?.mirror?.url) ? (
                    <a
                      href={mirrorLink(repos.find((x) => x.domain === r.domain)!.mirror!.url)!}
                      target="_blank"
                      rel="noreferrer noopener"
                      style={{ fontSize: 11 }}
                    >
                      open in mirror ↗
                    </a>
                  ) : null}
                  <div>
                    <button className="btn ghost sm" style={{ fontSize: 11, marginTop: 4 }} onClick={() => void toggleLog(r.domain)}>
                      {openLog === r.domain ? 'hide commit log' : 'commit log'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {openLog && commits[openLog] ? (
              <tr>
                <td colSpan={5}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                    {openLog}: the last {commits[openLog].length} commits, newest first — the repository&apos;s own log.
                    {logNote[openLog] ? <> {logNote[openLog]}</> : null}
                  </div>
                  <table className="tbl" style={{ fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th>Commit</th>
                        <th>Action</th>
                        <th>Object</th>
                        <th>By</th>
                        <th>From</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {commits[openLog].map((c) => (
                        <tr key={c.sha}>
                          <td className="mono" title={c.sha}>{c.short}</td>
                          <td>
                            {c.action}
                            {c.platform ? <span className="badge" style={{ marginLeft: 6, fontSize: 10 }}>OS catch-up</span> : null}
                          </td>
                          <td className="mono">{c.object}</td>
                          <td>{c.author}</td>
                          <td className="mono">{c.surface}</td>
                          <td>{new Date(c.at).toLocaleString()}</td>
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

      <h3 style={{ fontSize: 14, margin: '22px 0 6px' }}>What lives where</h3>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        The authoritative layout, from the kernel's own table — the same one the enumeration test
        gates, so this cannot drift from the code. <span className="mono">docs/components/git.md</span>{' '}
        carries it in prose.
      </p>
      <table className="tbl" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>Object</th>
            <th>Path in the domain repo</th>
            <th>Personal lane</th>
            <th>In git?</th>
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
                <span className={`badge ${l.status === 'in git' ? 'ok' : l.status === 'landing' ? 'warn' : ''}`}>{l.status}</span>
                <div className="muted" style={{ fontSize: 11, maxWidth: 380 }}>{l.detail}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
