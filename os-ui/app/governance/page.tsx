'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';

type Cell = { principal: string; decisions: Record<string, boolean> };
type Data = {
  principals: string[];
  tools: string[];
  grants: Record<string, string[]>;
  matrix: Cell[];
};

export default function GovernancePage() {
  const { data, loading, error, reload } = useApi<Data>('/api/policy');

  return (
    <>
      <PageHeader title="Governance" crumb="default-deny tool authorization — OPA" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Open Policy Agent makes the default-deny decision at the tool boundary: a
            principal may invoke a tool only if it is explicitly granted. Each cell below
            is live-verified against the OPA decision API — internet tools
            (<code>web_fetch</code>) are denied unless granted.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {data ? (
          <>
            <div className="section-title">Grants matrix · principal × tool</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Principal</th>
                    {data.tools.map((t) => (
                      <th key={t} className="mono" style={{ textTransform: 'none' }}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.matrix.map((row) => (
                    <tr key={row.principal}>
                      <td className="mono" style={{ fontWeight: 600 }}>{row.principal}</td>
                      {data.tools.map((t) => (
                        <td key={t} style={{ textAlign: 'center' }}>
                          {row.decisions[t] ? (
                            <span className="badge ok">allow</span>
                          ) : (
                            <span className="badge err">deny</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="hint">
              Source: OPA <code>grants</code> data, each cell re-checked via{' '}
              <code>POST /v1/data/agentic/authz/allow</code>. Add a tool under a principal
              in <code>opa.grants</code> to extend access.
            </div>
          </>
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading policy…</div>
        ) : null}
      </div>
    </>
  );
}
