/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState, useMemo } from 'react';
import McpConnect from '@/components/McpConnect';

/**
 * Client-safe mirror of CatalogEntry from lib/agents/tool-catalog.
 * Defined inline to avoid importing the server-only module.
 */
type CatalogEntry = {
  name: string;
  tab: string;
  minRole: string;
  description: string;
  requires_approval: boolean;
};

const TAB_LABELS: Record<string, string> = {
  data: 'Data',
  knowledge: 'Knowledge',
  files: 'Files',
  metrics: 'Metrics',
  dashboards: 'Dashboards',
  bigbets: 'Big Bets',
  connections: 'Connections',
  science: 'Science',
  software: 'Software',
  agents: 'Agents',
  governance: 'Governance',
  marketplace: 'Marketplace',
  strategy: 'Strategy',
  monitoring: 'Monitoring',
  meta: 'Meta / Discovery',
};

// Matches MCP_TABS order; meta (cross-cutting discovery tools) last.
const TAB_ORDER = [
  'data', 'knowledge', 'files', 'metrics', 'dashboards',
  'bigbets', 'connections', 'science', 'software', 'agents',
  'governance', 'marketplace', 'strategy', 'monitoring', 'meta',
];

const ROLE_LABEL: Record<string, string> = {
  creator: 'creator',
  builder: 'builder',
  domain_admin: 'domain admin',
  admin: 'admin',
};

const ROLE_BADGE: Record<string, string> = {
  creator: 'badge muted',
  builder: 'badge ok',
  domain_admin: 'badge warn',
  admin: 'badge cert-gold',
};

/**
 * Searchable, grouped MCP tool reference. Receives the full tool catalog from
 * the server component (no client-side fetch needed) and lets users filter by
 * tool name or description. Grouped by OS area / tab.
 */
export default function McpToolsClient({ tools }: { tools: CatalogEntry[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [tools, query]);

  const groups = useMemo(() => {
    const byTab: Record<string, CatalogEntry[]> = {};
    for (const tool of filtered) {
      (byTab[tool.tab] ??= []).push(tool);
    }
    return TAB_ORDER.filter((tab) => byTab[tab]?.length).map((tab) => ({
      tab,
      label: TAB_LABELS[tab] ?? tab,
      tools: byTab[tab],
    }));
  }, [filtered]);

  return (
    <>
      <div className="section-title" style={{ marginTop: 28 }}>Connect your AI tool</div>
      <McpConnect />

      <div className="section-title" style={{ marginTop: 32 }}>Tool reference</div>
      <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 16px', maxWidth: 640, lineHeight: 1.6 }}>
        Every tool the OS exposes over MCP, grouped by area.{' '}
        <strong>Who can use it</strong> is the minimum role — that role and above may call
        the tool at runtime.{' '}
        <span className="badge warn" style={{ verticalAlign: 'middle' }}>needs approval</span>{' '}
        marks write tools that may be held in the Governance queue when called by an agent.
      </p>

      <input
        placeholder="Filter by tool name or description…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ maxWidth: 400, marginBottom: 20 }}
        aria-label="Filter tools"
      />

      {groups.length === 0 ? (
        <div className="hint">No tools match &ldquo;{query}&rdquo;.</div>
      ) : (
        groups.map(({ tab, label, tools: tabTools }) => (
          <div key={tab} style={{ marginBottom: 24 }}>
            <div className="section-title">{label}</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>What it does</th>
                    <th>Who can use it</th>
                    <th>Approval</th>
                  </tr>
                </thead>
                <tbody>
                  {tabTools.map((t) => (
                    <tr key={t.name}>
                      <td
                        className="mono"
                        style={{ whiteSpace: 'nowrap', fontWeight: 500, fontSize: 12.5 }}
                      >
                        {t.name}
                      </td>
                      <td
                        className="muted"
                        style={{ fontSize: 12.5, maxWidth: 380, whiteSpace: 'normal', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        title={t.description}
                      >
                        {t.description}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className={ROLE_BADGE[t.minRole] ?? 'badge muted'}>
                          {ROLE_LABEL[t.minRole] ?? t.minRole}
                        </span>
                      </td>
                      <td>
                        {t.requires_approval ? (
                          <span className="badge warn">needs approval</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </>
  );
}
