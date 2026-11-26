/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * I18N:       converted (wave 2) — texts from `admin.mcpTools.*`. Tool names and descriptions are machine-facing
 *             and stay English; role names stay as the OS shows them.
 */
'use client';

import { useState, useMemo, type ReactNode } from 'react';
import { useTranslations } from '@core/i18n/client';
import McpConnect from '@tabs/admin/ui/McpConnect';

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

// Matches MCP_TABS order; meta (cross-cutting discovery tools) last. Each tab's group label is
// `admin.mcpTools.tabs.<tab>`.
const TAB_ORDER = [
  'data', 'knowledge', 'files', 'metrics', 'dashboards',
  'connections', 'software', 'agents',
  'governance', 'monitoring', 'meta',

] as const;

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
  const t = useTranslations('admin');
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
      label: t(`mcpTools.tabs.${tab}`),
      tools: byTab[tab],
    }));
  }, [filtered, t]);

  return (
    <>
      <div className="section-title" style={{ marginTop: 0 }}>{t('mcpTools.connectTitle')}</div>
      <McpConnect />

      <div className="section-title" style={{ marginTop: 32 }}>{t('mcpTools.refTitle')}</div>
      <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 16px', maxWidth: 640, lineHeight: 1.6 }}>
        {t.rich('mcpTools.refIntro', {
          strong: (c: ReactNode) => <strong>{c}</strong>,
          badge: (c: ReactNode) => <span className="badge warn" style={{ verticalAlign: 'middle' }}>{c}</span>,
        })}
      </p>

      <input
        placeholder={t('mcpTools.filterPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ maxWidth: 400, marginBottom: 20 }}
        aria-label={t('mcpTools.filterAria')}
      />

      {groups.length === 0 ? (
        <div className="hint">{t('mcpTools.noMatch', { query })}</div>
      ) : (
        groups.map(({ tab, label, tools: tabTools }) => (
          <div key={tab} style={{ marginBottom: 24 }}>
            <div className="section-title">{label}</div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('mcpTools.thTool')}</th>
                    <th>{t('mcpTools.thWhat')}</th>
                    <th>{t('mcpTools.thWho')}</th>
                    <th>{t('mcpTools.thApproval')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tabTools.map((tool) => (
                    <tr key={tool.name}>
                      <td
                        className="mono"
                        style={{ whiteSpace: 'nowrap', fontWeight: 500, fontSize: 12.5 }}
                      >
                        {tool.name}
                      </td>
                      <td
                        className="muted"
                        style={{ fontSize: 12.5, maxWidth: 380, whiteSpace: 'normal', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        title={tool.description}
                      >
                        {tool.description}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className={ROLE_BADGE[tool.minRole] ?? 'badge muted'}>
                          {ROLE_LABEL[tool.minRole] ?? tool.minRole}
                        </span>
                      </td>
                      <td>
                        {tool.requires_approval ? (
                          <span className="badge warn">{t('mcpTools.needsApproval')}</span>
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
