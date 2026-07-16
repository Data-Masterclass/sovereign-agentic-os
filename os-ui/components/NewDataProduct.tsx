/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';
import { useUser } from '@/lib/useUser';

/**
 * "New data product" — the guided golden path (data-golden-path.md). Six stages,
 * each preview-first and each persisting a real artifact through the registry, so
 * a non-engineer goes Load → Transform → Document → Metrics → Dashboards → Use in
 * agents without touching YAML. Every stage scaffolds the real tool underneath
 * (Iceberg/query-tool, dbt, Cube, Superset, the governed agent tools) and the
 * final stage PROVES the agent's number equals the dashboard's.
 */

type Stage = 0 | 1 | 2 | 3 | 4 | 5;
const STAGES = ['Load', 'Transform', 'Document', 'Metrics', 'Dashboards', 'Use in agents'];

type Preview = { columns: string[]; rows: string[][]; engine?: string } | null;
type Parity = {
  question: string; equal: boolean; verdict: string; quarter: string; policy: string;
  metrics: { value: number | null; source: string; traced: boolean };
  query: { value: number | null; source: string; sql: string; traced: boolean };
  dashboard: { value: number | null; source: string };
} | null;

const DEFAULT_STG_SQL =
  'select region, sum(net_amount) as revenue, count(*) as orders\nfrom sales_orders\ngroup by region\norder by revenue desc';

async function postJSON(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export default function NewDataProduct({ onDone }: { onDone?: () => void }) {
  const { user } = useUser();
  const [stage, setStage] = useState<Stage>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Record<number, string>>({}); // stage -> note

  // product identity
  const [name, setName] = useState('Sales');
  const [description, setDescription] = useState('Orders → daily/region revenue mart. The worked example.');
  const [visibility, setVisibility] = useState<'Personal' | 'Shared'>('Shared');

  // stage data
  const [loadPreview, setLoadPreview] = useState<Preview>(null);
  const [sql, setSql] = useState(DEFAULT_STG_SQL);
  const [transformPreview, setTransformPreview] = useState<Preview>(null);
  const [metricPreview, setMetricPreview] = useState<{ region: string; revenue: string }[] | null>(null);
  const [parity, setParity] = useState<Parity>(null);
  const [agentQ, setAgentQ] = useState('What was revenue in DE last quarter?');
  const [agentA, setAgentA] = useState<{ answer: string; tool: string; traced: boolean; value: number | null } | null>(null);

  const mark = (s: number, note: string) => setDone((d) => ({ ...d, [s]: note }));

  // ---- Stage 1: Load — preview the raw Iceberg table + register a dataset ----
  const runLoad = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const { ok, data } = await postJSON('/api/query', { sql: 'select * from sales_orders limit 12' });
      if (!ok) { setError(data.error ?? 'Could not read the raw table'); return; }
      setLoadPreview({ columns: data.columns, rows: data.rows, engine: data.engine });
      const reg = await postJSON('/api/artifacts', {
        type: 'dataset', name: `${name} — raw orders`, description: 'CSV loaded to a raw Iceberg table, cataloged in Polaris.',
        tags: ['raw', 'iceberg', 'csv'], spec: { table: 'sales_orders', rows: data.rowCount, layer: 'raw' },
      });
      if (reg.ok) mark(0, 'Raw Iceberg table sales_orders registered as a dataset.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [name]);

  // ---- Stage 2: Transform — preview dbt mart SQL + register a transformation ----
  const runTransform = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const { ok, data } = await postJSON('/api/query', { sql });
      if (!ok) { setError(data.error ?? 'Transform preview failed'); return; }
      setTransformPreview({ columns: data.columns, rows: data.rows, engine: data.engine });
      const reg = await postJSON('/api/artifacts', {
        type: 'transformation', name: `${name} — mart_sales`, description: 'dbt staging + mart with not_null/unique tests; Dagster-scheduled.',
        tags: ['dbt', 'mart', 'dagster'], spec: { sql, materialization: 'table', tests: ['not_null', 'unique', 'accepted_values'] },
      });
      if (reg.ok) mark(1, 'dbt mart_sales scaffolded (model + tests) and registered.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [sql, name]);

  // ---- Stage 3: Document — write the data product + set visibility ----
  const runDocument = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const reg = await postJSON('/api/artifacts', {
        type: 'dataset', name, description,
        tags: ['data-product', 'documented', 'lineage'],
        spec: { table: 'mart_sales', layer: 'mart', lineage: 'sales_orders → stg_orders → mart_sales', catalog: 'OpenMetadata (Domain: Sales)', requestedVisibility: visibility },
      });
      if (!reg.ok) { setError(reg.data.error ?? 'Could not register the data product'); return; }
      const note = visibility === 'Shared'
        ? 'Data product registered + lineage cataloged. Ask a builder to promote it to Domain, then certify to Company.'
        : 'Data product registered (My) + lineage cataloged.';
      mark(2, note);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [name, description, visibility]);

  // ---- Stage 4: Metrics — define Revenue (Cube) + preview by region ----
  const runMetrics = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const { ok, data } = await postJSON('/api/data/tool', {
        tool: 'metrics',
        query: { measures: ['mart_sales.revenue'], dimensions: ['mart_sales.region'], order: { 'mart_sales.revenue': 'desc' } },
      });
      if (!ok) { setError(`${data.error ?? 'Cube metric preview failed'} — is the mart_sales cube loaded?`); return; }
      const rows = (data.rows ?? []) as Record<string, unknown>[];
      setMetricPreview(rows.map((r) => ({ region: String(r['mart_sales.region'] ?? ''), revenue: String(r['mart_sales.revenue'] ?? '') })));
      const reg = await postJSON('/api/artifacts', {
        type: 'metric', name: `${name} — Revenue`, description: 'Canonical KPI: Revenue = sum(net_amount). One definition for dashboards + agents.',
        tags: ['cube', 'revenue', 'kpi'], spec: { cube: 'mart_sales', measures: ['mart_sales.revenue', 'mart_sales.orders'], dimensions: ['mart_sales.region', 'mart_sales.order_date'] },
      });
      if (reg.ok) mark(3, 'Cube Revenue metric defined — the single source of truth for the KPI.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [name]);

  // ---- Stage 5: Dashboards — register a Superset dashboard on the Cube metric ----
  const runDashboard = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const reg = await postJSON('/api/artifacts', {
        type: 'dashboard', name: `${name} Overview`, description: 'Superset dashboard built on the Cube Revenue metric — same numbers as the agent.',
        tags: ['superset', 'cube', 'bi'], spec: { engine: 'superset', metric: 'mart_sales.revenue', charts: ['Revenue by region', 'Revenue over time'] },
      });
      if (reg.ok) mark(4, 'Sales Overview dashboard registered on the Cube metric.');
      else setError(reg.data.error ?? 'Could not register the dashboard');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [name]);

  // ---- Stage 6: Use in agents — the parity proof + a live agent Q&A ----
  const runParity = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/data/parity', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Parity check failed'); return; }
      setParity(data);
      const reg = await postJSON('/api/artifacts', {
        type: 'agent', name: `${name} Agent`, description: 'LangGraph agent with governed Cube metrics + Trino query tools (OPA + Langfuse).',
        tags: ['langgraph', 'metrics-tool', 'query-tool'], spec: { tools: ['metrics', 'query'], grounding: 'mart_sales', proof: data.equal ? `match=${data.metrics.value}` : 'pending' },
      });
      if (reg.ok) mark(5, data.equal ? `Proven: agent == dashboard == ${data.metrics.value}.` : 'Agent registered; parity pending.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [name]);

  const askAgent = useCallback(async () => {
    setBusy(true); setError(''); setAgentA(null);
    try {
      const { ok, data } = await postJSON('/api/data/sales-agent', { question: agentQ });
      if (!ok) { setError(data.error ?? 'Agent failed'); return; }
      setAgentA({ answer: data.answer, tool: data.tool, traced: data.traced, value: data.value });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [agentQ]);

  const next = () => setStage((s) => (Math.min(5, s + 1) as Stage));
  const prev = () => setStage((s) => (Math.max(0, s - 1) as Stage));

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        The guided golden path. Each stage previews against the real tool underneath, then registers
        an artifact you (and your domain) can see, edit, promote and reuse. The worked example is
        pre-filled — just click through. Created as <strong>{user?.domains[0] ?? '…'}</strong>.
      </p>

      {/* Stepper */}
      <div className="tabstrip" style={{ flexWrap: 'wrap' }}>
        {STAGES.map((s, i) => (
          <button key={s} className={stage === i ? 'active' : ''} onClick={() => setStage(i as Stage)}>
            {done[i] ? '✓ ' : `${i + 1}. `}{s}
          </button>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}

      {/* Stage 1: Load */}
      {stage === 0 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>1 · Load — CSV/Parquet → raw Iceberg table</div>
          <p className="hint" style={{ marginTop: 0 }}>
            Upload a file or use the sample <code>sales_orders.csv</code>. It lands as a raw Iceberg table in
            the domain&apos;s object-storage prefix, registered in Polaris. Nothing analytical goes to Supabase.
          </p>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Data product name…" style={{ flex: '1 1 200px' }} />
            <a className="btn ghost" href="/sample/sales_orders.csv" download>Download sample CSV</a>
            <button className="btn" onClick={runLoad} disabled={busy}>{busy ? <span className="spin" /> : 'Load sample → preview'}</button>
          </div>
          {loadPreview ? <PreviewTable p={loadPreview} /> : null}
          {done[0] ? <div className="hint" style={{ color: 'var(--teal)' }}>✓ {done[0]}</div> : null}
        </div>
      ) : null}

      {/* Stage 2: Transform */}
      {stage === 1 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>2 · Transform — dbt staging + mart (preview before save)</div>
          <p className="hint" style={{ marginTop: 0 }}>
            The agent drafts the dbt SQL from your description; you preview the result against the lakehouse
            (Trino over Iceberg) before saving. Saving scaffolds the dbt model + tests and a Dagster asset.
          </p>
          <textarea className="mono" rows={5} value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} />
          <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={runTransform} disabled={busy}>{busy ? <span className="spin" /> : 'Preview + save model'}</button>
          </div>
          {transformPreview ? <PreviewTable p={transformPreview} /> : null}
          {done[1] ? <div className="hint" style={{ color: 'var(--teal)' }}>✓ {done[1]}</div> : null}
        </div>
      ) : null}

      {/* Stage 3: Document */}
      {stage === 2 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>3 · Document — name, owner, visibility, catalog + lineage</div>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the data product…" />
          <div className="row" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}>
            <span className="hint" style={{ marginTop: 0 }}>Target visibility:</span>
            {(['Personal', 'Shared'] as const).map((v) => (
              <button key={v} className={`chip${visibility === v ? '' : ''}`} style={{ cursor: 'pointer', background: visibility === v ? undefined : 'transparent' }} onClick={() => setVisibility(v)}>{v === 'Shared' ? 'Domain' : v === 'Personal' ? 'My' : v}</button>
            ))}
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={runDocument} disabled={busy}>{busy ? <span className="spin" /> : 'Register data product'}</button>
          </div>
          <p className="hint">Registers in OpenMetadata under Domain &quot;{name}&quot; with lineage (csv → staging → mart), and writes the data product to the artifact registry — auto-listed in the Marketplace once Certified.</p>
          {done[2] ? <div className="hint" style={{ color: 'var(--teal)' }}>✓ {done[2]}</div> : null}
        </div>
      ) : null}

      {/* Stage 4: Metrics */}
      {stage === 3 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>4 · Metrics — define Revenue once (Cube semantic layer)</div>
          <p className="hint" style={{ marginTop: 0 }}>
            <code>Revenue = sum(net_amount)</code> with dimensions region + date. Cube becomes the single
            source of truth — every dashboard and agent resolves &quot;Revenue&quot; the same way.
          </p>
          <button className="btn" onClick={runMetrics} disabled={busy}>{busy ? <span className="spin" /> : 'Define + preview Revenue'}</button>
          {metricPreview ? (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table><thead><tr><th>region</th><th>revenue</th></tr></thead>
                <tbody>{metricPreview.map((r) => <tr key={r.region}><td>{r.region}</td><td>{r.revenue}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {done[3] ? <div className="hint" style={{ color: 'var(--teal)' }}>✓ {done[3]}</div> : null}
        </div>
      ) : null}

      {/* Stage 5: Dashboards */}
      {stage === 4 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>5 · Dashboards — Superset on the Cube metric</div>
          <p className="hint" style={{ marginTop: 0 }}>
            A &quot;{name} Overview&quot; dashboard built on the Cube Revenue metric (consistent numbers). Sharing maps
            Superset RBAC to the artifact&apos;s visibility.
          </p>
          <button className="btn" onClick={runDashboard} disabled={busy}>{busy ? <span className="spin" /> : 'Register dashboard'}</button>
          {done[4] ? <div className="hint" style={{ color: 'var(--teal)' }}>✓ {done[4]}</div> : null}
        </div>
      ) : null}

      {/* Stage 6: Use in agents */}
      {stage === 5 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>6 · Use in agents — governed tools + the parity proof</div>
          <p className="hint" style={{ marginTop: 0 }}>
            The agent calls a governed <strong>metrics</strong> tool (Cube) and a <strong>query</strong> tool (Trino over the
            same Iceberg mart), both OPA-authorized + Langfuse-traced. Because it reads the same metric and mart
            as the dashboard, the numbers can&apos;t disagree — prove it:
          </p>
          <button className="btn" onClick={runParity} disabled={busy}>{busy ? <span className="spin" /> : 'Run the parity proof'}</button>
          {parity ? (
            <div style={{ marginTop: 14 }}>
              <div className={`card ${parity.equal ? '' : ''}`} style={{ borderColor: parity.equal ? 'var(--teal)' : undefined }}>
                <div style={{ fontWeight: 600 }}>{parity.question}</div>
                <table style={{ marginTop: 10, width: '100%' }}>
                  <tbody>
                    <tr><td>Agent · metrics tool (Cube)</td><td className="mono" style={{ textAlign: 'right' }}>{fmt(parity.metrics.value)}</td><td>{parity.metrics.traced ? '· traced' : ''}</td></tr>
                    <tr><td>Agent · query tool (Trino/Iceberg)</td><td className="mono" style={{ textAlign: 'right' }}>{fmt(parity.query.value)}</td><td>{parity.query.traced ? '· traced' : ''}</td></tr>
                    <tr><td>Dashboard (Superset on Cube)</td><td className="mono" style={{ textAlign: 'right' }}>{fmt(parity.dashboard.value)}</td><td /></tr>
                  </tbody>
                </table>
                <div className="hint" style={{ marginTop: 8, color: parity.equal ? 'var(--teal)' : 'var(--text-faint)' }}>
                  {parity.equal ? '✓ ' : ''}{parity.verdict} <span className="mono">[policy: {parity.policy}]</span>
                </div>
              </div>
            </div>
          ) : null}

          <div className="section-title">Ask the Sales agent</div>
          <div className="row" style={{ gap: 8 }}>
            <input value={agentQ} onChange={(e) => setAgentQ(e.target.value)} style={{ flex: 1 }} />
            <button className="btn" onClick={askAgent} disabled={busy || !agentQ.trim()}>{busy ? <span className="spin" /> : 'Ask'}</button>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {['What was revenue in DE last quarter?', 'Show the revenue breakdown by product in DE', 'How many orders in FR last quarter?'].map((ex) => (
              <button key={ex} type="button" className="chip" style={{ cursor: 'pointer', background: 'transparent' }} onClick={() => setAgentQ(ex)}>{ex}</button>
            ))}
          </div>
          {agentA ? (
            <div className="answer" style={{ marginTop: 12 }}>
              <div className="bubble-role">via {agentA.tool} tool {agentA.traced ? '· traced in Langfuse' : ''}</div>
              <div style={{ marginTop: 6 }}>{agentA.answer}</div>
            </div>
          ) : null}
          {done[5] ? <div className="hint" style={{ color: 'var(--teal)', marginTop: 10 }}>✓ {done[5]}</div> : null}
        </div>
      ) : null}

      {/* Nav */}
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
        <button className="btn ghost" onClick={prev} disabled={stage === 0}>← Back</button>
        {stage < 5 ? (
          <button className="btn" onClick={next}>Next: {STAGES[stage + 1]} →</button>
        ) : (
          <button className="btn" onClick={() => onDone?.()}>Finish — view in workspace</button>
        )}
      </div>
    </div>
  );
}

function fmt(v: number | null): string {
  return v == null ? '—' : String(v);
}

function PreviewTable({ p }: { p: NonNullable<Preview> }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="hint" style={{ marginTop: 0 }}>Preview · {p.engine ?? 'trino'}</div>
      <div className="table-wrap">
        <table>
          <thead><tr>{p.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{p.rows.slice(0, 12).map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
