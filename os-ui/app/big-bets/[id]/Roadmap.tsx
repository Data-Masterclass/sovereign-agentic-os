/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { type BetView, type Readiness, READY_FILL, day, fmtDate } from '../types';

const LEGEND: { r: Readiness; label: string }[] = [
  { r: 'done', label: 'done' },
  { r: 'on-track', label: 'on track' },
  { r: 'at-risk', label: 'at risk' },
  { r: 'blocked', label: 'blocked' },
];

/**
 * The roadmap Gantt — horizontal bars on a shared time axis from the earliest
 * start to max(go-live, latest planned-ready). Pure flex/SVG, no chart library.
 */
export default function Roadmap({ view }: { view: BetView }) {
  const rcs = view.roadmap.components;
  if (rcs.length === 0) {
    return <div className="hint">No components on the roadmap yet — add one below to start the plan.</div>;
  }

  const byRef = new Map(view.components.map((c) => [c.status.refId, c]));
  const refTab = new Map(view.bet.components.map((r) => [r.id, r.tab]));
  const titleOf = (refId: string) => byRef.get(refId)?.artifact?.title ?? '🔒 members only';

  const starts = rcs.map((c) => day(c.start));
  const ends = rcs.map((c) => day(c.plannedReady));
  const t0 = Math.min(...starts);
  const t1 = Math.max(...ends, day(view.roadmap.goLive));
  const span = Math.max(t1 - t0, 86400000);
  const pos = (iso: string) => ((day(iso) - t0) / span) * 100;
  const goLivePct = ((day(view.roadmap.goLive) - t0) / span) * 100;

  return (
    <div>
      {/* axis caption */}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <span className="muted mono" style={{ fontSize: 11 }}>{fmtDate(new Date(t0).toISOString().slice(0, 10))}</span>
        <span className="muted" style={{ fontSize: 11 }}>
          go-live {fmtDate(view.roadmap.goLive)} · {view.roadmap.goLiveRealistic ? 'realistic' : <span style={{ color: 'var(--danger)' }}>at risk</span>}
        </span>
        <span className="muted mono" style={{ fontSize: 11 }}>{fmtDate(new Date(t1).toISOString().slice(0, 10))}</span>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {rcs.map((rc) => {
          const c = byRef.get(rc.refId);
          const tab = c?.artifact?.tab ?? refTab.get(rc.refId) ?? '';
          const left = Math.max(0, Math.min(100, pos(rc.start)));
          const right = Math.max(0, Math.min(100, pos(rc.plannedReady)));
          const width = Math.max(right - left, 1.5);
          const override = c?.status.override?.note;
          const deps = rc.dependsOn.map(titleOf).filter(Boolean);
          const late = rc.daysLate != null && rc.daysLate > 0;

          return (
            <div
              key={rc.refId}
              style={{ display: 'grid', gridTemplateColumns: '230px 1fr', gap: 14, alignItems: 'center' }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={titleOf(rc.refId)}
                >
                  {titleOf(rc.refId)}
                </div>
                <div className="muted mono" style={{ fontSize: 10.5 }}>
                  {tab}{c ? ` · ${c.status.label}` : ''}
                </div>
                {override ? (
                  <div style={{ fontSize: 10.5, color: 'var(--gold-text)' }} title="owner override">
                    ⚑ owner: {override}
                  </div>
                ) : null}
                {deps.length ? (
                  <div className="muted" style={{ fontSize: 10 }}>after: {deps.join(', ')}</div>
                ) : null}
              </div>

              <div className="bb-gantt-track">
                <div
                  style={{ position: 'absolute', left: `${Math.max(0, Math.min(100, goLivePct))}%`, top: -5, bottom: -5, width: 0, borderLeft: '2px dashed var(--gold)' }}
                  title={`go-live ${fmtDate(view.roadmap.goLive)}`}
                />
                <div
                  className="bb-bar"
                  title={`${fmtDate(rc.start)} → ${fmtDate(rc.plannedReady)} · ${rc.readiness}${late ? ` · ${rc.daysLate}d late` : ''}`}
                  style={{
                    position: 'absolute',
                    left: `${left}%`,
                    width: `${width}%`,
                    top: 5,
                    bottom: 5,
                    borderRadius: 5,
                    background: READY_FILL[rc.readiness],
                    border: '1px solid var(--border-strong)',
                  }}
                />
                {late ? (
                  <span
                    style={{ position: 'absolute', right: 6, top: 7, fontSize: 10, color: 'var(--danger)', fontWeight: 600 }}
                  >
                    {rc.daysLate}d late
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* legend */}
      <div className="row" style={{ gap: 16, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {LEGEND.map((l) => (
          <span key={l.r} className="muted" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 18, height: 10, borderRadius: 3, background: READY_FILL[l.r], border: '1px solid var(--border-strong)', display: 'inline-block' }} />
            {l.label}
          </span>
        ))}
        <span className="muted" style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 0, height: 12, borderLeft: '2px dashed var(--gold)', display: 'inline-block' }} />
          go-live
        </span>
      </div>
    </div>
  );
}
