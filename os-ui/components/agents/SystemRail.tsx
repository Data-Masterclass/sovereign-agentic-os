/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect } from 'react';
import { useApi } from '@/lib/useApi';

/**
 * The master–detail left rail: a compact list of the builder's systems shown while
 * one is open, so the tiles never disappear during edit/create (the old swap-nav
 * dropped them). Current system highlighted; "+ New" pinned on top. Fast switching
 * the previous UX lacked entirely. Reuses the same /api/agents/systems summaries.
 */

type Summary = {
  id: string; name: string; domain: string; owner: string;
  visibility: 'Personal' | 'Shared' | 'Marketplace';
  origin: 'authored' | 'forked';
  running: boolean; scheduled: boolean; agentCount: number; lastActivity: string | null;
};
type Groups = { mine: Summary[]; domain: Summary[]; marketplace: Summary[] };

export default function SystemRail({
  currentId,
  onOpen,
  onNew,
  onBack,
  reloadKey = 0,
}: {
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
  reloadKey?: number;
}) {
  const { data, loading, reload } = useApi<Groups>('/api/agents/systems');
  // Refresh the rail when the parent signals a change (create / rename / delete).
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [reloadKey]);
  const mine = data?.mine ?? [];
  const domain = data?.domain ?? [];

  const item = (s: Summary) => (
    <button
      key={s.id}
      className={`rail-item${s.id === currentId ? ' active' : ''}`}
      onClick={() => onOpen(s.id)}
      title={`${s.name} · ${s.agentCount} agent${s.agentCount === 1 ? '' : 's'}`}
    >
      <span className={`rail-dot ${s.running ? 'run' : s.scheduled ? 'sched' : 'idle'}`} />
      <span className="rail-name">{s.name}</span>
    </button>
  );

  return (
    <nav className="system-rail" aria-label="Your agent systems">
      <button className="rail-new" onClick={onNew}>+ New</button>
      <button className="rail-all" onClick={onBack}>← All systems</button>
      <div className="rail-scroll">
        {mine.length > 0 ? <div className="rail-group">Personal</div> : null}
        {mine.map(item)}
        {domain.length > 0 ? <div className="rail-group">Shared</div> : null}
        {domain.map(item)}
        {!loading && mine.length === 0 && domain.length === 0 ? (
          <div className="rail-empty">No systems yet.</div>
        ) : null}
        {loading && !data ? <div className="rail-empty"><span className="spin" /></div> : null}
      </div>
    </nav>
  );
}
