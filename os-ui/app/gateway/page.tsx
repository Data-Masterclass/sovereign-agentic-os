'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';

type Model = { id: string; ownedBy: string };
type Tool = { name: string; description: string; params: string[] };
type Data = {
  models: Model[];
  tools: Tool[];
  modelsError: string;
  toolsError: string;
};

export default function GatewayPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/gateway');

  return (
    <>
      <PageHeader title="Gateway" crumb="models & MCP tools — LiteLLM" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            The one governed endpoint agents call for both models and tools. LiteLLM
            enforces per-key access + cost caps, logs every call to Langfuse, and fronts
            the registered MCP tool servers. The master key stays server-side.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {data ? (
          <>
            <div className="section-title">Models</div>
            {data.modelsError ? (
              <div className="error">{data.modelsError}</div>
            ) : data.models.length === 0 ? (
              <div className="stub-page">No models registered.</div>
            ) : (
              <div className="grid">
                {data.models.map((m) => (
                  <div className="card" key={m.id}>
                    <h3 className="mono">{m.id}</h3>
                    <div className="muted">owned by {m.ownedBy || 'unknown'}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="section-title">MCP tools</div>
            {data.toolsError ? (
              <div className="error">{data.toolsError}</div>
            ) : data.tools.length === 0 ? (
              <div className="stub-page">No MCP tools registered.</div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {data.tools.map((t) => (
                  <div className="result" key={t.name}>
                    <div className="result-head">
                      <h4 className="mono">{t.name}</h4>
                      {t.params.length ? (
                        <span className="score">
                          args: {t.params.join(', ')}
                        </span>
                      ) : (
                        <span className="score">no args</span>
                      )}
                    </div>
                    <p className="result-text">{t.description || 'No description.'}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading gateway…</div>
        ) : null}
      </div>
    </>
  );
}
