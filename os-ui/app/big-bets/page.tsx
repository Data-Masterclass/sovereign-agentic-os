/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import PageHeader from '@/components/PageHeader';
import { BIG_BETS, type BetStatus } from '@/lib/planning';

// Server component: the strategic AI bets and value targets (os-application.md
// §4). Each bet links to the agents/software/data that deliver it and the value
// it targets. Static seed for v1 — the planning workspace.

const STATUS_CLASS: Record<BetStatus, string> = {
  live: 'badge ok',
  'in-flight': 'badge warn',
  planned: 'badge muted',
};

export default function BigBetsPage() {
  return (
    <>
      <PageHeader title="Big Bets" crumb="strategic AI bets & value targets — planning workspace" />
      <div className="content">
        <p className="lead">
          The high-value use cases this domain is investing in. Each bet states its thesis,
          the value it targets, current confidence, and the artifacts — agents, software,
          and data — that deliver it. This is the planning workspace; figures are the plan of
          record.
        </p>

        <div style={{ display: 'grid', gap: 16, marginTop: 8 }}>
          {BIG_BETS.map((b) => (
            <div className="card" key={b.name}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: 'var(--text)' }}>{b.name}</h3>
                    <span className={STATUS_CLASS[b.status]}>{b.status}</span>
                  </div>
                  <p className="muted" style={{ marginTop: 8, marginBottom: 0, maxWidth: 620 }}>
                    {b.thesis}
                  </p>
                </div>
                <div style={{ textAlign: 'right', minWidth: 150 }}>
                  <div className="big" style={{ fontSize: 20, color: 'var(--gold-light)' }}>
                    {b.value}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>targeted value</div>
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
                  <span className="muted" style={{ fontSize: 11.5 }}>Confidence</span>
                  <span className="muted mono" style={{ fontSize: 11.5 }}>{b.confidence}%</span>
                </div>
                <div
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${b.confidence}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, var(--gold-deep), var(--gold-light))',
                    }}
                  />
                </div>
              </div>

              <div className="sources" style={{ marginTop: 14 }}>
                {b.delivers.map((d) => (
                  <span className="chip" key={d}>{d}</span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="hint" style={{ marginTop: 20 }}>
          Bets trace back to the Strategy pillars and forward to the Agents, Software, and
          Structured Data that realize them. Edit via the inline editor (coming with the
          registry).
        </div>
      </div>
    </>
  );
}
