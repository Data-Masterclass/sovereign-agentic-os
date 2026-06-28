/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import PageHeader from '@/components/PageHeader';
import { PILLARS, FUNCTIONS, KPIS, READINESS_LABEL, type Readiness } from '@/lib/planning';

// Server component: the strategic / transformation-planning cockpit
// (os-application.md §4). Pillars + a readiness heatmap. Static seed for v1 —
// clearly the planning workspace; inline authoring + persistence land later.

const DOT: Record<Readiness, string> = {
  mature: 'up',
  developing: 'unknown',
  nascent: 'down',
};

export default function StrategyPage() {
  return (
    <>
      <PageHeader title="Strategy" crumb="agentic-transformation cockpit — planning workspace" />
      <div className="content">
        <p className="lead">
          The cockpit where this domain plans its agentic transformation: the strategic
          pillars, the functions that deliver them, and a readiness heatmap of where to
          invest next. This is the planning workspace — figures below are the current plan of
          record.
        </p>

        <div className="statusbar" style={{ marginTop: 8 }}>
          {KPIS.map((k) => (
            <div className="card" key={k.label} style={{ padding: '14px 16px' }}>
              <h3>{k.label}</h3>
              <div className="big">{k.value}</div>
              <div className="muted">{k.sub}</div>
            </div>
          ))}
        </div>

        <div className="section-title">Readiness heatmap · pillar × function</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Pillar</th>
                {FUNCTIONS.map((f) => (
                  <th key={f} style={{ textAlign: 'center' }}>{f}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PILLARS.map((p) => (
                <tr key={p.name}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="muted" style={{ whiteSpace: 'normal', maxWidth: 360 }}>
                      {p.intent}
                    </div>
                  </td>
                  {FUNCTIONS.map((f) => {
                    const r = p.readiness[f];
                    return (
                      <td key={f} style={{ textAlign: 'center' }} title={READINESS_LABEL[r]}>
                        <span
                          className={`status-dot ${DOT[r]}`}
                          style={{ display: 'inline-block', margin: '0 auto' }}
                        />
                        <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                          {READINESS_LABEL[r]}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="hint">
          Legend: <span className="badge ok">Mature</span>{' '}
          <span className="badge warn">Developing</span>{' '}
          <span className="badge err">Nascent</span>. Pillars feed the Big Bets portfolio;
          edit the plan via the inline editor (coming with the registry).
        </div>
      </div>
    </>
  );
}
