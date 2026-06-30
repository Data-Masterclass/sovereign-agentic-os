/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import type { HomeFeed } from '@/lib/home/feed';
import type { ModuleKey } from '@/lib/home/scope';
import AskAssistant from './AskAssistant';

/**
 * The cockpit — the personalized modules around the launcher (What needs me ·
 * My WIP · Domain pulse · Health & cost · Recent activity · Quick start + ask).
 * Each is a small card that links into its OWNING tab; ordering shifts by
 * persona (home-golden-path.md §"Role-aware emphasis"). Domain pulse + Health &
 * cost are MOCK feeds for the kind gate and say so (source badge) — Home reads
 * exactly what the adapter returns and never recomputes.
 */

function ModuleHead({ title, href, link, badge }: { title: string; href: string; link: string; badge?: string }) {
  return (
    <div className="cm-head">
      <h3 className="cm-title">{title}</h3>
      {badge ? <span className="cm-stub" title="Local stand-in for the kind gate — wired to the real tab at consolidation.">{badge}</span> : null}
      <Link className="cm-link" href={href}>
        {link} →
      </Link>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="cm-empty">{children}</div>;
}

export default function Cockpit({ feed }: { feed: HomeFeed }) {
  const M: Record<ModuleKey, React.ReactNode> = {
    needs: (
      <section className="cm" key="needs">
        <ModuleHead title="What needs me" href="/governance" link="Governance" />
        {feed.needs.length === 0 ? (
          <Empty>You're all clear — nothing is waiting on you.</Empty>
        ) : (
          <ul className="cm-list">
            {feed.needs.slice(0, 6).map((n) => (
              <li key={n.id} className="cm-item">
                <Link href={n.href} className="cm-item-main">
                  <span className={`cm-dot ${n.actionable ? 'act' : 'wait'}`} aria-hidden="true" />
                  <span>
                    <span className="cm-item-label">{n.label}</span>
                    <span className="cm-item-detail">{n.detail}</span>
                  </span>
                </Link>
                <span className={`badge ${n.actionable ? 'warn' : 'muted'}`}>
                  {n.actionable ? (n.kind === 'promote' ? 'Promote' : 'Review') : 'Waiting'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    ),
    wip: (
      <section className="cm" key="wip">
        <ModuleHead title="Personal work in progress" href="/data" link="Workspace" />
        {feed.wip.length === 0 ? (
          <Empty>No drafts in flight. Start one from a launcher card above.</Empty>
        ) : (
          <ul className="cm-list">
            {feed.wip.slice(0, 6).map((w) => (
              <li key={w.id} className="cm-item">
                <Link href={w.href} className="cm-item-main">
                  <span className="cm-dot draft" aria-hidden="true" />
                  <span>
                    <span className="cm-item-label">{w.name}</span>
                    <span className="cm-item-detail">{w.type}</span>
                  </span>
                </Link>
                <span className="badge vis-personal">{w.visibility}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    ),
    pulse: (
      <section className="cm" key="pulse">
        <ModuleHead title="Domain pulse" href="/strategy" link="Strategy" badge="stub" />
        <div className="cm-pulse">
          <div className="cm-gauge">
            <div className="cm-gauge-bar">
              <div className="cm-gauge-fill" style={{ width: `${Math.min(100, feed.pulse.valuePct)}%` }} />
            </div>
            <div className="cm-gauge-num">
              {feed.pulse.valuePct}
              <span>%</span>
            </div>
          </div>
          <div className="cm-pulse-label">{feed.pulse.valueLabel}</div>
          <div className="cm-stats">
            <span><b>{feed.pulse.activeCreators}</b> creators</span>
            <span><b>{feed.pulse.promotedThisPeriod}</b> promoted</span>
            <span><b>{feed.pulse.certifiedThisPeriod}</b> certified</span>
          </div>
          <ul className="cm-bets">
            {feed.pulse.bets.map((b) => (
              <li key={b.name}>
                <span className={`cm-bet-dot ${b.status}`} aria-hidden="true" />
                {b.name}
                <span className="cm-bet-status">{b.status.replace('-', ' ')}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    ),
    health: (
      <section className="cm" key="health">
        <ModuleHead title="Health & cost" href="/monitoring" link="Monitoring" badge="stub" />
        <div className="cm-health">
          {feed.health.redItems.length === 0 ? (
            <div className="cm-allgood">
              <span className="cm-dot act" aria-hidden="true" /> All green for your agents & pipelines.
            </div>
          ) : (
            <ul className="cm-list">
              {feed.health.redItems.map((r) => (
                <li key={r.name} className="cm-item">
                  <span className="cm-item-main">
                    <span className="cm-dot red" aria-hidden="true" />
                    <span>
                      <span className="cm-item-label">{r.name}</span>
                      <span className="cm-item-detail">{r.detail}</span>
                    </span>
                  </span>
                  <span className="badge err">red</span>
                </li>
              ))}
            </ul>
          )}
          <div className="cm-spend">
            <div className="cm-spend-row">
              <span>Spend vs cap</span>
              <span className="cm-spend-num">
                ${feed.health.spendUsd} <span className="muted">/ ${feed.health.capUsd}</span>
              </span>
            </div>
            <div className="cm-gauge-bar">
              <div
                className={`cm-gauge-fill ${feed.health.spendPct > 0.8 ? 'hot' : ''}`}
                style={{ width: `${Math.min(100, feed.health.spendPct * 100)}%` }}
              />
            </div>
          </div>
        </div>
      </section>
    ),
    recent: (
      <section className="cm" key="recent">
        <ModuleHead title="Recent activity" href="/marketplace" link="Marketplace" />
        {feed.recent.length === 0 ? (
          <Empty>Nothing new in the domain yet.</Empty>
        ) : (
          <ul className="cm-list">
            {feed.recent.slice(0, 6).map((a) => (
              <li key={a.id} className="cm-item">
                <Link href={a.href} className="cm-item-main">
                  <span className={`cm-dot ${a.event === 'certified' ? 'cert' : 'shared'}`} aria-hidden="true" />
                  <span>
                    <span className="cm-item-label">{a.name}</span>
                    <span className="cm-item-detail">
                      {a.event === 'certified' ? 'Certified' : 'Shared'} · {a.type} · {a.domain}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    ),
    ask: (
      <section className="cm cm-ask" key="ask">
        <ModuleHead title="Quick start + ask" href="/agents" link="Assistant" />
        <AskAssistant />
      </section>
    ),
  };

  return <div className="cockpit-grid">{feed.order.map((k) => M[k])}</div>;
}
