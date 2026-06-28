/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import { useApi } from '@/lib/useApi';

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

const STARTERS = [
  'Design a 3-agent system: a researcher, a writer, and a reviewer.',
  'Build a customer-support triage multi-agent system over our knowledge base.',
  'Plan a supervisor agent that routes to a SQL agent and a RAG agent.',
];

export default function AgentsPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/agents');
  const [tab, setTab] = useState<'running' | 'build'>('running');

  return (
    <>
      <PageHeader title="Agents" crumb="LangGraph multi-agent systems — run & build" />
      <div className="content">
        <p className="lead">
          See the multi-agent systems running on LangGraph, and design new ones with the
          agent builder. (Talk-to-your-data moved to the Data tab, where it belongs.)
        </p>

        <div className="tabstrip">
          <button className={tab === 'running' ? 'active' : ''} onClick={() => setTab('running')}>
            Running agents
          </button>
          <button className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}>
            Build a new system
          </button>
        </div>

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
        ) : (
          <>
            <div className="section-title">Agent builder</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Describe the multi-agent system you want. The builder proposes the agents, the
              graph, the tools + OPA grants, and a spec to scaffold. Codegen + deploy is a
              <strong> draft/plan for review</strong> in v1 — not a live deployment.
            </p>
            <AgentChat
              agent="agent-builder"
              label="agent builder"
              placeholder="e.g. Design a multi-agent system that drafts and reviews marketing copy…"
              starters={STARTERS}
            />
          </>
        )}
      </div>
    </>
  );
}
