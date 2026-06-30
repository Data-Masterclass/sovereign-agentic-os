/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import AgentSystems from '@/components/agents/AgentSystems';
import { useApi } from '@/lib/useApi';
import { anchorAttr, ANCHORS } from '@/lib/tutorials/anchors';

type Agent = {
  key: string;
  name: string;
  role: string;
  runtime: string;
  optional: boolean;
  up: boolean;
  detail: string;
};
type Data = { agents: Agent[]; up: number; total: number };

export default function AgentsPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/agents');

  return (
    <>
      <PageHeader title="Agents" crumb="LangGraph agent systems — author, build & run" tutorial="agents" />
      <div className="content">
        <p className="lead">
          Author agent systems against their real artifacts — drag the canvas, edit
          <span className="mono"> system.yaml</span>, or ask the agent assistant — then Build to
          execute and verify them across LangGraph, LiteLLM, OPA, and Langfuse.
        </p>

        <div {...anchorAttr(ANCHORS.agents.sandbox)}>
          <AgentSystems />
        </div>

        <div className="section-title" style={{ marginTop: 28 }} {...anchorAttr(ANCHORS.agents.run)}>
          Deployed agent systems
          {data ? (
            <span className={`count-pill${data.up === data.total ? ' ok' : ' warn'}`}>
              {data.up}/{data.total} up
            </span>
          ) : null}
          <button
            className="btn ghost"
            style={{ marginLeft: 'auto', padding: '4px 12px' }}
            onClick={reload}
            disabled={loading}
          >
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>
        {error ? <div className="error">{error}</div> : null}
        {data ? (
          <div className="grid">
            {data.agents.map((a) => (
              <div className="card" key={a.key}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0 }}>{a.name}</h3>
                  <span className={`badge ${a.up ? 'ok' : a.optional ? 'muted' : 'err'}`}>
                    {a.up ? 'running' : a.optional ? 'off' : 'down'}
                  </span>
                </div>
                <div className="muted" style={{ marginTop: 8 }}>{a.role}</div>
                <div className="muted mono" style={{ marginTop: 8, fontSize: 11.5 }}>
                  {a.runtime} · {a.key} · {a.detail}
                  {a.optional ? ' · opt-in' : ''}
                </div>
              </div>
            ))}
          </div>
        ) : loading ? (
          <div className="stub-page">Checking agent systems…</div>
        ) : null}
      </div>
    </>
  );
}
