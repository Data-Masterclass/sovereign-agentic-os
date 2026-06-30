/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import {
  euro,
  KIND_LABEL,
  KIND_ROUTE,
  BUILD_STATUS_LABEL,
  type ComponentBuildStatus,
} from '@/lib/strategy/model';
import ValueChart from './ValueChart';
import { fmtDate, statusCounts, type PillarCard, type DBet, type DComponent } from './types';

const STATUS_CLASS: Record<ComponentBuildStatus, string> = {
  planned: 'strat-st-planned',
  'in-progress': 'strat-st-progress',
  ready: 'strat-st-ready',
};

/**
 * The big-bet detail — a full-screen view opened from a pillar's bet box.
 * Top row: the current value-metric value + Planned/In progress/Ready counts.
 * Then the value-metric history chart, the roadmap (each component + its due
 * date), and every component as a box with an Edit→its-own-tab deep-link.
 */
export default function BetDetail({
  card,
  bet,
  onClose,
}: {
  card: PillarCard;
  bet: DBet;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const counts = statusCounts(bet.components);
  // The bet's value evolves with the pillar metric — scale the history by its share.
  const chartScale = bet.entitled && bet.sharePct ? bet.sharePct : 1;

  return (
    <div className="strat-detail" role="dialog" aria-modal="true" aria-label={`${bet.name} detail`}>
      <div className="strat-detail-inner">
        <header className="strat-detail-head">
          <button className="btn ghost sm" onClick={onClose} aria-label="Back to pillars">← Back</button>
          <div className="strat-detail-title">
            <h1>{bet.name}</h1>
            <div className="strat-detail-sub">
              <span className="badge muted">{bet.domain}</span>
              <span className="muted">in {card.pillar.name}</span>
            </div>
          </div>
        </header>

        {/* Top row of boxes — value + Planned / In progress / Ready */}
        <div className="strat-detail-stats">
          <div className="strat-statbox accent">
            <span className="strat-statbox-label">{card.rollup.metricTitle || 'Value'}</span>
            <span className="strat-statbox-value">{bet.entitled ? euro(bet.value) : 'Restricted'}</span>
            <span className="strat-statbox-foot">current value</span>
          </div>
          {(['planned', 'in-progress', 'ready'] as ComponentBuildStatus[]).map((s) => (
            <div key={s} className={`strat-statbox ${STATUS_CLASS[s]}`}>
              <span className="strat-statbox-label">{BUILD_STATUS_LABEL[s]}</span>
              <span className="strat-statbox-value">{counts[s]}</span>
              <span className="strat-statbox-foot">component{counts[s] === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>

        {/* Value metric over time */}
        <section className="strat-detail-section">
          <div className="section-title">Value metric over time</div>
          <ValueChart points={card.history} scale={chartScale} />
        </section>

        {/* Roadmap — each component with its due date */}
        <section className="strat-detail-section">
          <div className="section-title">Roadmap</div>
          <Roadmap bet={bet} />
        </section>

        {/* Components — boxes with Edit → own tab */}
        <section className="strat-detail-section">
          <div className="section-title">Components</div>
          <div className="strat-comp-grid">
            {bet.components.map((c) => <ComponentBox key={c.id} c={c} />)}
          </div>
        </section>

        {/* Audit — small print footer (governance kept, just subtle) */}
        {card.audit.length > 0 ? (
          <footer className="strat-audit-foot">
            {card.audit.slice(0, 4).map((e, i) => (
              <span key={i}>
                {e.action} · {e.actor} · {new Date(e.at).toLocaleDateString()}
                {i < Math.min(card.audit.length, 4) - 1 ? '  ·  ' : ''}
              </span>
            ))}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function Roadmap({ bet }: { bet: DBet }) {
  const dated = bet.components.filter((c) => c.dueDate);
  if (dated.length === 0) {
    return <div className="hint">No due dates set yet — components show here on a timeline once scheduled.</div>;
  }
  const day = (iso: string) => Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  const dues = dated.map((c) => day(c.dueDate!));
  const goLive = bet.goLive ? day(bet.goLive) : Math.max(...dues);
  const t0 = Math.min(...dues, Date.now());
  const t1 = Math.max(...dues, goLive);
  const span = Math.max(t1 - t0, 86_400_000);
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - t0) / span) * 100));
  const ordered = [...dated].sort((a, b) => day(a.dueDate!) - day(b.dueDate!));

  return (
    <div className="strat-roadmap">
      {ordered.map((c) => (
        <div key={c.id} className="strat-roadmap-row">
          <div className="strat-roadmap-name">
            <span>{c.name}</span>
            <span className="muted mono">{KIND_LABEL[c.kind]} · due {fmtDate(c.dueDate)}</span>
          </div>
          <div className="strat-roadmap-track">
            {bet.goLive ? (
              <span className="strat-roadmap-golive" style={{ left: `${pct(goLive)}%` }} title={`go-live ${fmtDate(bet.goLive)}`} />
            ) : null}
            <span
              className={`strat-roadmap-bar ${STATUS_CLASS[c.status]}`}
              style={{ width: `${Math.max(pct(day(c.dueDate!)), 3)}%` }}
            />
            <span className="strat-roadmap-dot" style={{ left: `${pct(day(c.dueDate!))}%` }} />
          </div>
        </div>
      ))}
      {bet.goLive ? (
        <div className="hint" style={{ marginTop: 6 }}>Dashed marker = go-live {fmtDate(bet.goLive)}.</div>
      ) : null}
    </div>
  );
}

function ComponentBox({ c }: { c: DComponent }) {
  const href = c.artifactId
    ? `${KIND_ROUTE[c.kind]}?focus=${encodeURIComponent(c.artifactId)}`
    : KIND_ROUTE[c.kind];
  return (
    <div className="strat-comp">
      <div className="strat-comp-head">
        <span className="badge muted">{KIND_LABEL[c.kind]}</span>
        <span className={`strat-comp-status ${STATUS_CLASS[c.status]}`}>{BUILD_STATUS_LABEL[c.status]}</span>
      </div>
      <div className="strat-comp-name">{c.name}</div>
      <div className="strat-comp-meta">
        <span className="mono">{c.entitled ? euro(c.value) : '—'}</span>
        <span className="muted">due {fmtDate(c.dueDate)}</span>
      </div>
      <Link className="btn ghost sm strat-comp-edit" href={href}>
        Edit in {KIND_LABEL[c.kind]} →
      </Link>
    </div>
  );
}
