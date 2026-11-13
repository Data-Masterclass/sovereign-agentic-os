/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `<GitHeadBadge/>` — the one git line every detail header mounts
 * USER STORY: As any user I want the same "git <sha> by <author> <when>" line on my dataset, KPI,
 *             dashboard, agent system and app, and clicking it to open the history (checklist G6).
 * ARCHITECTURE:
 *   - A SHELL. Every decision — the label, the tooltip, the empty states — is in `git-view.ts`,
 *     which the tests import; this file renders and fetches, nothing else.
 *   - One mount line per header: `<GitHeadBadge kind="dataset" id={dataset.id} />`. The tabs own
 *     nothing else about git, so the five surfaces cannot drift apart.
 *   - Honest when there is nothing: "not in git" / "no commit yet" with the reason in the
 *     tooltip — never a fabricated sha and never a silent absence.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import HistoryDrawer from '@core/ui/git/HistoryDrawer';
import { badgeView, type GitInfoView } from '@core/ui/git/git-view';

export type GitHeadBadgeProps = {
  /** The object kind, as `core/infra/git-objects.ts` names it. */
  kind: 'dataset' | 'metric' | 'dashboard' | 'agent-system' | 'software' | 'lifecycle-pin';
  id: string;
  /** Commits to load for the drawer (default 10). */
  limit?: number;
};

type Loaded = GitInfoView & { restorable?: boolean };

export default function GitHeadBadge({ kind, id, limit }: GitHeadBadgeProps) {
  const [info, setInfo] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ action: 'history', kind, id, ...(limit ? { limit: String(limit) } : {}) });
      const res = await fetch(`/api/git?${params.toString()}`, { cache: 'no-store' });
      setInfo(res.ok ? ((await res.json()) as Loaded) : null);
    } catch {
      // A read that cannot reach the repository is an honest "not in git", never a guess.
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [kind, id, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <span className="muted" style={{ fontSize: 11 }}>git …</span>;
  const view = badgeView(info);
  return (
    <>
      <button
        className="btn ghost sm"
        style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', flex: 'none' }}
        title={view.title}
        onClick={() => setOpen(true)}
        aria-label={view.label ? `Git history — ${view.label}` : 'Git history'}
      >
        {view.label ? <>git {view.label}</> : <span className="muted">git — {view.empty}</span>}
      </button>
      {open ? (
        <HistoryDrawer
          kind={kind}
          id={id}
          info={info}
          restorable={!!info?.restorable}
          onClose={() => setOpen(false)}
          onRestored={() => void load()}
        />
      ) : null}
    </>
  );
}
