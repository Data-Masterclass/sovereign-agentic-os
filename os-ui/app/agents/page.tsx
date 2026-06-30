/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import SalesAssistant from '@/components/SalesAssistant';
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
  const [tab, setTab] = useState<'systems' | 'sales' | 'running'>('systems');

  return (
    <>
      <PageHeader title="Agents" crumb="LangGraph multi-agent systems — author, build & run" tutorial="agents" />
      <div className="content">
        <p className="lead">
          Author agent systems against their real artifacts — drag the canvas, edit
          <span className="mono"> system.yaml</span>, or ask the agent-system helper — then Build to
          execute and verify them across LangGraph, LiteLLM, OPA and Langfuse.
        </p>

        <div className="tabstrip">
          <button className={tab === 'systems' ? 'active' : ''} onClick={() => setTab('systems')} {...anchorAttr(ANCHORS.agents.sandbox)}>
            Systems
          </button>
          <button className={tab === 'sales' ? 'active' : ''} onClick={() => setTab('sales')} {...anchorAttr(ANCHORS.agents.tools)}>
            Sales Assistant
          </button>
          <button className={tab === 'running' ? 'active' : ''} onClick={() => setTab('running')} {...anchorAttr(ANCHORS.agents.run)}>
            Running agents
          </button>
        </div>

        {tab === 'systems' ? <AgentSystems /> : null}

        {tab === 'sales' ? (
          <>
            <div className="section-title">Sales Assistant · governed vertical slice</div>
            <SalesAssistant />
          </>
        ) : null}

        {tab === 'running' ? (
          <>
            <div className="section-title">
              Deployed agents
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
              <div className="stub-page">Probing agents…</div>
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}
