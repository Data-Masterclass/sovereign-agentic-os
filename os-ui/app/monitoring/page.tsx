/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import '../monitoring.css';

/**
 * Monitoring — the artifact-centric read plane. Two sections, each grouped
 * My · Domain · Company: you monitor the things you actually built or use.
 *   • Agent Monitoring — every accessible agent system + its last-run health.
 *   • Data Monitoring  — every accessible dataset, with pipeline + data-quality
 *                        rolled into ONE health per dataset.
 * Read-only. Click a row to open that artifact (runs/trace live in Agents;
 * DQ tests + pipeline live in Data). RAG (Files/Knowledge) is a later section.
 */

type Health = 'green' | 'amber' | 'red' | 'grey';
type ScopeKey = 'mine' | 'domain' | 'marketplace';

type AgentRow = {
  id: string; name: string; scope: ScopeKey; agentCount: number;
  running: boolean; scheduled: boolean; lastRunAt: number | null;
  lastRunOk: boolean | null; held: number; health: Health;
};
type DataRow = {
  id: string; name: string; scope: ScopeKey; health: Health;
  pipeline: Health; dq: Health; quality: 'unknown' | 'passing' | 'failing';
  freshness: string | null; ageDays: number | null; gold: boolean;
};
type Feed = {
  agents: { mine: AgentRow[]; domain: AgentRow[]; marketplace: AgentRow[] };
  data: { mine: DataRow[]; domain: DataRow[]; marketplace: DataRow[] };
};

const SCOPES: { key: ScopeKey; label: string }[] = [
  { key: 'mine', label: 'My' },
  { key: 'domain', label: 'Domain' },
  { key: 'marketplace', label: 'Company' },
];

const DOT_COLOR: Record<Health, string> = {
  green: '#16a34a', amber: '#d97706', red: '#dc2626', grey: 'var(--text-faint, #9ca3af)',
};
const HEALTH_WORD: Record<Health, string> = {
  green: 'Healthy', amber: 'Attention', red: 'Failing', grey: 'No signal',
};

function Dot({ h, title }: { h: Health; title?: string }) {
  return (
    <span
      title={title ?? HEALTH_WORD[h]}
      style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 999, background: DOT_COLOR[h], flex: '0 0 auto' }}
    />
  );
}

/** "3h ago" / "2d ago" / "just now" from an ms epoch or ISO string. */
function ago(at: number | string | null): string {
  if (at == null) return '—';
  const t = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

function ScopeTabs({ scope, setScope, counts }: { scope: ScopeKey; setScope: (s: ScopeKey) => void; counts: Record<ScopeKey, number> }) {
  return (
    <div className="seg" style={{ marginBottom: 10 }}>
      {SCOPES.map((s) => (
        <button key={s.key} className={scope === s.key ? 'on' : ''} onClick={() => setScope(s.key)} type="button">
          {s.label} <span className="muted" style={{ fontSize: 11 }}>· {counts[s.key]}</span>
        </button>
      ))}
    </div>
  );
}

function Row({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
        borderBottom: '1px solid var(--line, #ececec)', cursor: 'pointer',
      }}
      className="mon-row"
    >
      {children}
    </div>
  );
}

export default function MonitoringPage() {
  const { data, loading, error, reload } = useApi<Feed>('/api/monitoring/artifacts');
  const router = useRouter();
  const [agentScope, setAgentScope] = useState<ScopeKey>('mine');
  const [dataScope, setDataScope] = useState<ScopeKey>('mine');

  const agentCounts = useMemo(() => ({
    mine: data?.agents.mine.length ?? 0,
    domain: data?.agents.domain.length ?? 0,
    marketplace: data?.agents.marketplace.length ?? 0,
  }), [data]);
  const dataCounts = useMemo(() => ({
    mine: data?.data.mine.length ?? 0,
    domain: data?.data.domain.length ?? 0,
    marketplace: data?.data.marketplace.length ?? 0,
  }), [data]);

  const agentRows = data?.agents[agentScope] ?? [];
  const dataRows = data?.data[dataScope] ?? [];

  return (
    <>
      <PageHeader title="Monitoring" crumb="agents · data — the read plane" tutorial="monitoring" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Health of the agent systems and datasets you can access. Read-only —
            click any row to open it (runs &amp; traces live in Agents; data-quality
            and pipeline detail live in Data).
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}
        {!data && loading ? <div className="stub-page" style={{ marginTop: 20 }}>Loading…</div> : null}

        {data && (
          <>
            {/* ───────────── Agent Monitoring ───────────── */}
            <div className="section-title" style={{ marginTop: 18 }}>Agent Monitoring</div>
            <ScopeTabs scope={agentScope} setScope={setAgentScope} counts={agentCounts} />
            {agentRows.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                No agent systems here yet — build or run one in the <a href="/agents">Agents</a> tab.
              </p>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {agentRows.map((a) => (
                  <Row key={a.id} onClick={() => router.push(`/agents?focus=${a.id}`)}>
                    <Dot h={a.health} />
                    <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                    <span className="badge muted">{a.agentCount} agent{a.agentCount === 1 ? '' : 's'}</span>
                    {a.running ? <span className="badge ok">running</span> : null}
                    {a.scheduled ? <span className="badge">scheduled</span> : null}
                    {a.held > 0 ? <span className="badge warn">{a.held} held</span> : null}
                    <span className="muted" style={{ fontSize: 12, minWidth: 96, textAlign: 'right' }}>
                      {a.lastRunAt == null ? 'not run yet' : `${a.lastRunOk === false ? 'failed · ' : ''}${ago(a.lastRunAt)}`}
                    </span>
                  </Row>
                ))}
              </div>
            )}

            {/* ───────────── Data Monitoring ───────────── */}
            <div className="section-title" style={{ marginTop: 22 }}>Data Monitoring</div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
              One health per dataset — pipeline freshness and data-quality checks combined.
            </p>
            <ScopeTabs scope={dataScope} setScope={setDataScope} counts={dataCounts} />
            {dataRows.length === 0 ? (
              <p className="hint" style={{ marginTop: 0 }}>
                No datasets here yet — create one in the <a href="/data">Data</a> tab.
              </p>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {dataRows.map((d) => (
                  <Row key={d.id} onClick={() => router.push(`/data?focus=${d.id}`)}>
                    <Dot h={d.health} />
                    <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Dot h={d.pipeline} title={`Pipeline: ${HEALTH_WORD[d.pipeline]}`} /> pipeline
                    </span>
                    <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <Dot h={d.dq} title={`Data quality: ${HEALTH_WORD[d.dq]}`} /> quality
                    </span>
                    <span className="muted" style={{ fontSize: 12, minWidth: 96, textAlign: 'right' }}>
                      {d.freshness == null ? 'not built' : ago(d.freshness)}
                    </span>
                  </Row>
                ))}
              </div>
            )}

            <p className="hint" style={{ marginTop: 18, opacity: 0.7 }}>
              RAG monitoring (Knowledge &amp; Files) is coming next. Spend lives in the LLM Gateway tab;
              policy and caps live in Governance.
            </p>
          </>
        )}
      </div>
    </>
  );
}
