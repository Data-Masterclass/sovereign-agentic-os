'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type Trace = {
  id: string;
  name: string | null;
  input: string;
  output: string;
  timestamp: string | null;
  tags: string[];
};

function fmt(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export default function MonitoringPage() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/traces', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? 'Failed to load traces');
      else setTraces(data.traces ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <PageHeader title="Monitoring" crumb="recent agent traces — Langfuse" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            What your agents did, scoped to this domain&apos;s Langfuse project. The
            project key stays server-side.
          </p>
          <button className="btn ghost" onClick={load} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        <div style={{ marginTop: 20 }}>
          {error ? <div className="error">{error}</div> : null}
          {!error && !loading && traces.length === 0 ? (
            <div className="stub-page">No traces yet. Ask the agent on the Agents tab.</div>
          ) : null}
          {traces.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Tags</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {traces.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 600 }}>{t.name ?? '—'}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 280 }}>{t.input}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 280 }}>{t.output}</td>
                      <td>{t.tags.join(', ')}</td>
                      <td>{fmt(t.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
