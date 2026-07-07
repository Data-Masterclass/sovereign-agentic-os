/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import AgentChat from '@/components/AgentChat';
import ArtifactPanel from '@/components/ArtifactPanel';
import GovernedConnections from '@/components/GovernedConnections';
import { useApi } from '@/lib/useApi';
import { CONNECTORS, CONNECTOR_CATEGORIES } from '@/lib/connectors';

type AppTool = { name: string; description: string; write: boolean };
type AppConn = {
  id: string;
  appId: string;
  appSlug: string;
  name: string;
  principal: string;
  owner: string;
  domain: string;
  visibility: 'Personal' | 'Shared' | 'Certified';
  tools: AppTool[];
};
type AppConns = { connections: AppConn[] };

const STARTERS = [
  'Connect my Google Drive so agents can read my files.',
  'Connect a OneDrive folder where finance drops invoices.',
  'Connect my Notion workspace via its hosted MCP.',
];

export default function ConnectionsPage() {
  const { data: appConns } = useApi<AppConns>('/api/connections/apps');
  const [tab, setTab] = useState<'mine' | 'registry' | 'governed' | 'build'>('mine');

  return (
    <>
      <PageHeader title="Connections" crumb="external systems · build connectors — registry + agent" tutorial="connections" />
      <div className="content">
        <p className="lead">
          The external systems this domain brings in — databases, APIs and SaaS — registered as governed
          connections that expose <strong>APIs or MCPs as tools</strong> for your agents and software.
          Credentials go to the secrets store and are never exposed — you share <em>use</em>, never the
          secret, under policy. The connections agent drafts new connectors for you. (Internal platform
          services live in <Link href="/platform/components">Platform → Components</Link>.)
        </p>

        <div className="tabstrip">
          <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>Personal connections</button>
          <button className={tab === 'registry' ? 'active' : ''} onClick={() => setTab('registry')}>Registry</button>
          <button className={tab === 'governed' ? 'active' : ''} onClick={() => setTab('governed')}>Governed connections</button>
          <button className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}>Build a connector</button>
        </div>

        {tab === 'mine' ? (
          <ArtifactPanel
            type="connection"
            createLabel="Register connection"
            specFields={[
              { key: 'kind', label: 'Source type', placeholder: 'postgres | rest-api | onedrive | s3' },
              { key: 'endpoint', label: 'Endpoint / host', placeholder: 'db.internal:5432 / https://api.example.com' },
            ]}
            renderSpec={(a) => (a.spec?.kind || a.spec?.endpoint ? (
              <div className="muted mono" style={{ fontSize: 11 }}>{a.spec?.kind ? <>kind: {String(a.spec.kind)}<br /></> : null}{a.spec?.endpoint ? <>endpoint: {String(a.spec.endpoint)}</> : null}</div>
            ) : null)}
            intro={
              <p className="hint" style={{ marginTop: 0 }}>
                Connections you (and your domain) own, share, or added from the Marketplace — same
                Personal → Shared → Certified lifecycle as every artifact. Credentials live in the secrets
                store; you share <em>use</em>, never the secret. Live wiring is <strong>scaffolded in v1</strong>.
              </p>
            }
          />
        ) : null}

        {tab === 'governed' ? (
          <GovernedConnections />
        ) : tab === 'registry' ? (
          <>
            <div className="section-title">App MCP connections (auto-generated)</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
              Every app you build in the Software tab auto-generates an MCP, registered here as a
              governed Connection + agent tool. Building an app and creating a connection are one act.
            </p>
            {(appConns?.connections?.length ?? 0) === 0 ? (
              <div className="stub-page">No app connections yet — build one in the Software tab.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Connection</th><th>Principal</th><th>Tools</th><th>Visibility</th><th>App</th></tr>
                  </thead>
                  <tbody>
                    {appConns!.connections.map((c) => (
                      <tr key={c.id}>
                        <td style={{ fontWeight: 600 }}>{c.name}</td>
                        <td className="mono">{c.principal}</td>
                        <td className="muted mono" style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.tools.map((t) => t.name).join(', ')}>{c.tools.map((t) => t.name).join(', ')}</td>
                        <td><span className={`badge vis-${c.visibility.toLowerCase()}`}>{c.visibility}</span></td>
                        <td><Link className="btn ghost" href={`/software/${c.appId}`}>Open →</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

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
        ) : null}

        {tab === 'build' ? (
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
        ) : null}
      </div>
    </>
  );
}
