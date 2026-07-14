/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useUser } from '@/lib/useUser';
import { SCOPE_GROUPS, groupByScope, scopeCounts, type ScopeKey } from '@/lib/core/scopes';
import DomainTag from '@/components/DomainTag';
import {
  TIER_BADGE,
  TIER_LABEL,
  TASK_LABEL,
  BUILD_STATE,
  type ModelGroups,
  type ModelSummary,
} from './shared';

/**
 * The models LIST surface — every model the user can see, grouped All · My · Shared ·
 * Marketplace via the OS-wide scope helper (identical to Dashboards' Tiles). Each tile
 * shows the task-type chip, a coloured buildState status dot, and the tier badge.
 * Clicking a tile OPENS its detail (overview, predict, tier ladder, lifecycle). The
 * ＋ New model button + archived toggle live in the tab header row above (canonical).
 */
export default function ModelTiles({
  data,
  loading,
  error,
  onOpen,
  showArchived = false,
}: {
  data: ModelGroups | null;
  loading: boolean;
  error: string;
  onOpen: (m: ModelSummary) => void;
  showArchived?: boolean;
}) {
  const [scope, setScope] = useState<ScopeKey>('all');
  const { user } = useUser();

  const uid = user?.id ?? '';
  const groups = data ? { mine: data.mine, domain: data.domain, marketplace: data.marketplace } : null;
  const scoped = groups ? groupByScope(groups, uid) : null;
  const counts = groups ? scopeCounts(groups, uid) : null;
  const scopedAll = scoped ? scoped[scope] : [];
  const visible = scopedAll.filter((m) => !m.archived);
  const archived = scopedAll.filter((m) => m.archived);

  const card = (m: ModelSummary) => {
    const bs = m.buildState ? BUILD_STATE[m.buildState] : null;
    return (
      <button
        key={m.model}
        type="button"
        className="card tile"
        onClick={() => onOpen(m)}
        title="Open this model — overview, predict, promote or govern it"
      >
        <div className="tile-top">
          <span className="tile-name">{m.name}</span>
          <div className="row" style={{ gap: 4, alignItems: 'center' }}>
            {scope === 'shared' || scope === 'marketplace' || scope === 'all' ? <DomainTag domain={m.domain} /> : null}
            <span className={`badge ${TIER_BADGE[m.tier]}`}>{TIER_LABEL[m.tier]}</span>
          </div>
        </div>
        <div className="tile-meta muted" style={{ alignItems: 'center', gap: 6 }}>
          {m.spec ? <span className="badge muted">{TASK_LABEL[m.spec.taskType]}</span> : null}
          {bs ? (
            <span className="row" style={{ gap: 5, alignItems: 'center' }}>
              <span className={`status-dot ${bs.dot}`} />
              <span>{bs.label}</span>
            </span>
          ) : null}
        </div>
        <div className="tile-foot">
          <span className="hint" style={{ marginTop: 0 }}>owner {m.owner}</span>
          <span className="hint" style={{ marginTop: 0 }}>open ↗</span>
        </div>
      </button>
    );
  };

  return (
    <>
      {error ? <div className="error" style={{ marginTop: 16 }}>{error}</div> : null}
      {loading && !data ? <div className="stub-page">Loading models…</div> : null}

      {data ? (
        <div className="seg" style={{ marginTop: 14 }}>
          {SCOPE_GROUPS.map((g) => (
            <button key={g.key} type="button" className={scope === g.key ? 'on' : ''} onClick={() => setScope(g.key)}>
              {g.label('Models')}{counts ? ` (${counts[g.key]})` : ''}
            </button>
          ))}
        </div>
      ) : null}

      {data && visible.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 16 }}>
          {scope === 'mine' || scope === 'all'
            ? 'No models yet — register one with ＋ New model.'
            : scope === 'shared' ? 'Nothing shared in your domain yet.' : 'Nothing in the marketplace yet.'}
        </div>
      ) : null}

      {visible.length ? <div className="tile-grid" style={{ marginTop: 16 }}>{visible.map(card)}</div> : null}

      {showArchived ? (
        archived.length > 0 ? (
          <>
            <div className="section-title" style={{ marginTop: 24 }}>
              Archived<span className="count-pill">{archived.length}</span>
            </div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              Archived models are hidden from the working lists (retained). Open one to Restore or Delete it.
            </p>
            <div className="tile-grid">{archived.map(card)}</div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 16 }}>No archived models.</div>
        )
      ) : null}
    </>
  );
}
