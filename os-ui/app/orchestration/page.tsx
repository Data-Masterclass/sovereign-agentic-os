'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';

type Run = { runId: string; status: string; pipeline: string; startTime: number | null };
type Data = {
  assets: string[];
  runs: Run[];
  assetsError: string;
  runsError: string;
  consoleUrl: string;
};

function fmt(secs: number | null): string {
  if (!secs) return '';
  const d = new Date(secs * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function statusClass(s: string): string {
  const v = s.toUpperCase();
  if (v === 'SUCCESS') return 'badge ok';
  if (v === 'FAILURE' || v === 'CANCELED') return 'badge err';
  if (v === 'STARTED' || v === 'QUEUED') return 'badge warn';
  return 'badge muted';
}

export default function OrchestrationPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/orchestration');

  return (
    <>
      <PageHeader title="Orchestration" crumb="dbt assets & runs — Dagster" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Dagster orchestrates the data tier — it loads the dbt project as assets and
            runs <code>dbt build</code>. Below are the materializable assets and recent
            runs, read from the Dagster GraphQL API.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {data ? (
          <>
            <div className="section-title">Assets</div>
            {data.assetsError ? (
              <div className="error">{data.assetsError}</div>
            ) : data.assets.length === 0 ? (
              <div className="stub-page">No assets.</div>
            ) : (
              <div className="grid">
                {data.assets.map((a) => (
                  <div className="card" key={a}>
                    <h3 className="mono">{a}</h3>
                    <div className="muted">dbt / Dagster asset</div>
                  </div>
                ))}
              </div>
            )}

            <div className="section-title">Recent runs</div>
            {data.runsError ? (
              <div className="error">{data.runsError}</div>
            ) : data.runs.length === 0 ? (
              <div className="stub-page">
                No runs yet — materialize an asset in Dagster to create one.
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Status</th>
                      <th>Pipeline</th>
                      <th>Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((r) => (
                      <tr key={r.runId}>
                        <td className="mono">{r.runId.slice(0, 8)}</td>
                        <td><span className={statusClass(r.status)}>{r.status}</span></td>
                        <td>{r.pipeline}</td>
                        <td>{fmt(r.startTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="section-title">Console</div>
            <div className="card row" style={{ alignItems: 'center', gap: 14, maxWidth: 480 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>Dagster</div>
                <div className="muted mono">{data.consoleUrl || 'internal — not publicly exposed; use the port-forward'}</div>
              </div>
              {data.consoleUrl ? (
                <a className="btn ghost" href={data.consoleUrl} target="_blank" rel="noreferrer">
                  Open →
                </a>
              ) : (
                <span className="btn ghost" aria-disabled="true" title="Internal — reach via port-forward" style={{ opacity: 0.5, cursor: 'default' }}>
                  Internal
                </span>
              )}
            </div>
          </>
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading orchestration…</div>
        ) : null}
      </div>
    </>
  );
}
