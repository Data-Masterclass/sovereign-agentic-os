/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import McpConnect from '@/components/McpConnect';
import { useApi } from '@/lib/useApi';
import type { McpRegistry, RegistryEntry, RegistrySection } from '@/lib/platform-admin/mcp-registry';
import { visibilityLabel } from '@/lib/core/scopes';

type Data = { registry: McpRegistry; opa: string; gatewayReachable: boolean };

/** A single MCP/API entry — one calm card. No nesting; import lives outside. */
function EntryCard({
  entry,
  open,
  onToggleImport,
}: {
  entry: RegistryEntry;
  open: boolean;
  onToggleImport: (tab: string | undefined) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const tools = showAll ? entry.tools : entry.tools.slice(0, 6);
  const more = entry.tools.length - tools.length;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong>{entry.name}</strong>
        <span className="pa-tag">{entry.kind === 'api' ? 'API' : entry.transport ?? 'MCP'}</span>
      </div>

      <p className="muted" style={{ margin: '8px 0', fontSize: 12.5 }}>{entry.description}</p>

      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
        {entry.endpoint}
      </div>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <span className="badge muted">{entry.scope}</span>
        {entry.visibility ? <span className="badge">{visibilityLabel(entry.visibility)}</span> : null}
        {entry.live === false ? <span className="badge warn">not live yet</span> : null}
      </div>

      {entry.tools.length ? (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>
            Tools · {entry.tools.length}
          </div>
          <div>
            {tools.map((t) => (
              <span className="chip mono" key={t.name} title={t.description ?? ''}>{t.name}</span>
            ))}
            {more > 0 ? (
              <button className="btn ghost" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setShowAll(true)}>
                +{more} more
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 10 }}>
          {entry.kind === 'api' ? 'HTTP API — no MCP tools.' : 'No tools exposed yet.'}
        </div>
      )}

      {entry.importable ? (
        <div style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={() => onToggleImport(entry.mcpTab)}>
            {open ? 'Hide import' : 'Import to Claude / ChatGPT'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Section({
  section,
  openImport,
  setOpenImport,
}: {
  section: RegistrySection;
  openImport: { id: string; tab: string | undefined } | null;
  setOpenImport: (v: { id: string; tab: string | undefined } | null) => void;
}) {
  return (
    <section style={section.primary ? { paddingLeft: 14, borderLeft: '2px solid var(--gold-line)' } : undefined}>
      <div className="section-title" style={section.primary ? { marginTop: 26, color: 'var(--gold)' } : undefined}>
        {section.title}
        <span className="count-pill">{section.entries.length}</span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '-4px 0 14px', maxWidth: 720 }}>{section.subtitle}</p>

      {section.entries.length === 0 ? (
        <div className="hint">None yet.</div>
      ) : (
        <div className="grid">
          {section.entries.map((e) => {
            const open = openImport?.id === e.id;
            return (
              <EntryCard
                key={e.id}
                entry={e}
                open={open}
                onToggleImport={(tab) => setOpenImport(open ? null : { id: e.id, tab })}
              />
            );
          })}
        </div>
      )}

      {/* Import panel rendered OUTSIDE the grid (no card-in-card): reuses McpConnect,
          scoped to the chosen tab, only for entries in THIS section. */}
      {openImport && section.entries.some((e) => e.id === openImport.id) ? (
        <div style={{ marginTop: 14 }}>
          <McpConnect tab={openImport.tab} />
        </div>
      ) : null}
    </section>
  );
}

export default function McpApisPage() {
  const { data, loading, error, reload } = useApi<Data>('/api/platform-admin/mcp-apis');
  const [openImport, setOpenImport] = useState<{ id: string; tab: string | undefined } | null>(null);

  return (
    <>
      <PageHeader title="MCPs & APIs" crumb="platform · every MCP server & API available in the OS" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            One registry for every governed tool surface: the OS&rsquo;s own MCP servers &amp; APIs, the bundled
            stack tools, and the MCPs your apps &amp; connections generate — shared across a domain or private to you.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>{loading ? <span className="spin" /> : 'Refresh'}</button>
        </div>

        {error ? <div className="error" style={{ marginTop: 18 }}>{error}</div> : null}

        {data ? (
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {data.registry.sections.map((s) => (
              <Section key={s.tier} section={s} openImport={openImport} setOpenImport={setOpenImport} />
            ))}
          </div>
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading the registry…</div>
        ) : null}
      </div>
    </>
  );
}
