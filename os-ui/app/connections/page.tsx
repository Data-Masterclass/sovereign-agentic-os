/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import { useApi } from '@/lib/useApi';
import { CONNECTORS, CONNECTOR_CATEGORIES } from '@/lib/connectors';

type Service = { key: string; label: string; up: boolean; detail: string };
type Status = { services: Service[]; up: number; total: number };

const STARTERS = [
  'Build a connector to a OneDrive folder of invoices.',
  'Connect a read-only PostgreSQL database of orders.',
  'Build a connector to a REST API with bearer auth.',
];

export default function ConnectionsPage() {
  const { data, loading, error, reload } = useApi<Status>('/api/status');
  const [tab, setTab] = useState<'registry' | 'build'>('registry');

  return (
    <>
      <PageHeader title="Connections" crumb="registry · build connectors — live status + agent" />
      <div className="content">
        <p className="lead">
          Every backend this domain is wired to, plus the external sources you can register.
          Credentials go to the secrets store and are never exposed — you share <em>use</em>,
          never the secret, under policy. The connections agent drafts new connectors for you.
        </p>

        <div className="tabstrip">
          <button className={tab === 'registry' ? 'active' : ''} onClick={() => setTab('registry')}>Registry</button>
          <button className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}>Build a connector</button>
        </div>

        {tab === 'registry' ? (
          <>
            <div className="section-title">
              Platform services
              {data ? (
                <span className={`count-pill${data.up === data.total ? ' ok' : ' warn'}`}>{data.up}/{data.total} connected</span>
              ) : null}
              <button className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 12px' }} onClick={reload} disabled={loading}>
                {loading ? <span className="spin" /> : 'Refresh'}
              </button>
            </div>
            {error ? <div className="error">{error}</div> : null}
            {data ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Connection</th><th>Service</th><th>Status</th><th>Detail</th></tr>
                  </thead>
                  <tbody>
                    {data.services.map((s) => (
                      <tr key={s.key}>
                        <td style={{ fontWeight: 600 }}>{s.label}</td>
                        <td className="mono">{s.key}</td>
                        <td><span className={`badge ${s.up ? 'ok' : 'err'}`}>{s.up ? 'connected' : 'down'}</span></td>
                        <td className="muted">{s.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : loading ? (
              <div className="stub-page">Checking connections…</div>
            ) : null}

            <div className="section-title">Supported connectors</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
              Register an external source as a connection. Available drivers can be added now; the rest are on the roadmap.
            </p>
            {CONNECTOR_CATEGORIES.map((cat) => {
              const items = CONNECTORS.filter((c) => c.category === cat);
              if (items.length === 0) return null;
              return (
                <div key={cat} style={{ marginBottom: 18 }}>
                  <div className="mono" style={{ color: 'var(--text-faint)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{cat}</div>
                  <div className="grid">
                    {items.map((c) => (
                      <div className="card" key={c.name}>
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                          <h3 style={{ margin: 0 }}>{c.name}</h3>
                          <span className={`badge ${c.available ? 'ok' : 'muted'}`}>{c.available ? 'available' : 'roadmap'}</span>
                        </div>
                        <div className="muted" style={{ marginTop: 8 }}>Auth: {c.auth}</div>
                        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                          <button className="btn ghost" onClick={() => setTab('build')} disabled={!c.available}>
                            {c.available ? 'Register →' : 'Soon'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <div className="section-title">Connections agent</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              Describe the source you want to connect. The agent drafts the connector type,
              required credentials (held in the secrets store), and a config to scaffold.
              Building/registering the connection is <strong>scaffolded</strong> in v1 — the draft is for review.
            </p>
            <AgentChat
              agent="connections"
              label="connections agent"
              placeholder="e.g. Connect a OneDrive folder where finance drops monthly invoices…"
              starters={STARTERS}
            />
          </>
        )}
      </div>
    </>
  );
}
