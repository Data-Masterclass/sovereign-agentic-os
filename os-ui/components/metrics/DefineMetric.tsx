/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type DatasetGroups,
  type DefineResult,
  BuildRowsView,
  ChecksList,
} from './shared';

/** The aggregations Cube supports (mirrors lib/data/metrics MEASURE_TYPES). */
const AGGREGATIONS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'number'] as const;
type Aggregation = (typeof AGGREGATIONS)[number];

type Form = { name: string; aggregation: Aggregation; column: string; dimensions: string[] };
type Mode = 'form' | 'agent' | 'yaml';

const EMPTY: Form = { name: '', aggregation: 'sum', column: '', dimensions: [] };

function DatasetPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [groups, setGroups] = useState<DatasetGroups | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/data/datasets', { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) setGroups(data);
      } catch { /* surfaced by the define call if it matters */ }
    })();
  }, []);

  const all = groups ? [...groups.mine, ...groups.domain, ...groups.marketplace] : [];
  const tierLabel = { dataset: 'private', asset: 'asset', product: 'product' } as const;

  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 240 }}>
      <option value="">choose a dataset…</option>
      {all.map((d) => (
        <option key={d.id} value={d.id}>{d.name} · {tierLabel[d.tier]}</option>
      ))}
    </select>
  );
}

/** Fetch the host dataset's REAL columns so the pickers never take a typed name. */
function useColumns(datasetId: string): string[] {
  const [columns, setColumns] = useState<string[]>([]);
  useEffect(() => {
    if (!datasetId) { setColumns([]); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' });
        const data = await res.json();
        if (live && res.ok) {
          const cols = (data?.dataset?.columns ?? []) as { name: string }[];
          setColumns(cols.map((c) => c.name).filter(Boolean));
        }
      } catch { if (live) setColumns([]); }
    })();
    return () => { live = false; };
  }, [datasetId]);
  return columns;
}

export default function DefineMetric({ onDefined }: { onDefined: () => void }) {
  const [datasetId, setDatasetId] = useState('');
  const [mode, setMode] = useState<Mode>('form');
  const [form, setForm] = useState<Form>(EMPTY);
  const [prompt, setPrompt] = useState('define revenue as the sum of net_amount by region');
  const [usedAgent, setUsedAgent] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentErr, setAgentErr] = useState('');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<DefineResult | null>(null);

  const columns = useColumns(datasetId);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const toggleDimension = (col: string) =>
    setForm((f) => ({
      ...f,
      dimensions: f.dimensions.includes(col) ? f.dimensions.filter((d) => d !== col) : [...f.dimensions, col],
    }));

  // The agent proposes a metric grounded in the dataset's real columns via the ONE
  // governed assistant LLM; the user reviews the proposed fields, then defines.
  const askAgent = useCallback(async () => {
    if (!datasetId) { setAgentErr('Pick a host dataset first.'); return; }
    setAgentErr(''); setAgentBusy(true);
    try {
      const res = await fetch('/api/metrics/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datasetId, goal: prompt }),
      });
      const data = await res.json();
      if (!res.ok) { setAgentErr(data.error ?? 'The metric agent could not propose a metric'); return; }
      const p = data.form as { name: string; aggregation: Aggregation; column: string; dimensions: string[] };
      setForm({
        name: p.name ?? '',
        aggregation: (AGGREGATIONS as readonly string[]).includes(p.aggregation) ? p.aggregation : 'sum',
        column: p.column ?? '',
        dimensions: Array.isArray(p.dimensions) ? p.dimensions : [],
      });
      setUsedAgent(true);
    } catch (e) { setAgentErr((e as Error).message); } finally { setAgentBusy(false); }
  }, [datasetId, prompt]);

  const submit = useCallback(async () => {
    setErr(''); setBusy(true); setResult(null);
    const payload = {
      name: form.name.trim(),
      aggregation: form.aggregation,
      column: form.column.trim(),
      dimensions: form.dimensions,
    };
    try {
      const res = await fetch('/api/metrics/define', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // In agent mode we send the SAME accepted form as `agent` so the API can prove
        // form == agent; otherwise the server defaults agent to the form.
        body: JSON.stringify({ datasetId, form: payload, agent: usedAgent ? payload : undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not define the metric'); return; }
      setResult(data);
      onDefined();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [datasetId, form, usedAgent, onDefined]);

  const canSubmit =
    !busy && datasetId !== '' && form.name.trim() !== '' &&
    (form.aggregation === 'count' || form.column.trim() !== '');

  return (
    <>
      <p className="lead" style={{ marginTop: 4 }}>
        Define a measure once — by <strong>form</strong> or by <strong>agent</strong>. Both resolve to one
        artifact; the API proves they converge before it persists, so the definition can never fork. The
        generated <strong>Cube YAML</strong> is shown for review.
      </p>

      <div className="guided-panel">
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="comp-label" style={{ margin: 0 }}>Host dataset</span>
          <DatasetPicker value={datasetId} onChange={setDatasetId} />
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          A metric lives on a governed Gold <strong>asset</strong> or <strong>product</strong>.
          Pick a private dataset and the platform will tell you to promote it in Data first.
        </p>

        <div className="seg" style={{ marginTop: 14 }}>
          <button className={mode === 'form' ? 'on' : ''} onClick={() => setMode('form')}>Form</button>
          <button className={mode === 'agent' ? 'on' : ''} onClick={() => setMode('agent')}>Agent</button>
          <button className={mode === 'yaml' ? 'on' : ''} onClick={() => setMode('yaml')}>YAML</button>
        </div>

        {mode === 'agent' ? (
          <div style={{ marginTop: 14 }}>
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="describe the metric — e.g. total net revenue by region"
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn ghost" onClick={askAgent} disabled={agentBusy || !prompt.trim() || !datasetId}>
                {agentBusy ? <span className="spin" /> : 'Propose →'}
              </button>
              <span className="hint" style={{ marginTop: 6 }}>
                The agent proposes into the fields below using this dataset&apos;s real columns — review, then define.
              </span>
            </div>
            {agentErr ? <div className="error" style={{ marginTop: 10 }}>{agentErr}</div> : null}
          </div>
        ) : null}

        {mode === 'yaml' ? (
          <div style={{ marginTop: 14 }}>
            {result?.cube ? (
              <pre className="codeblock">{result.cube}</pre>
            ) : (
              <div className="stub-page">Define a metric (Form or Agent) — the generated Cube YAML appears here.</div>
            )}
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
              <input placeholder="name (e.g. Revenue)" value={form.name} onChange={(e) => set({ name: e.target.value })} style={{ maxWidth: 180 }} />
              <select value={form.aggregation} onChange={(e) => set({ aggregation: e.target.value as Aggregation })}>
                {AGGREGATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              {form.aggregation !== 'count' ? (
                <select
                  value={columns.includes(form.column) ? form.column : ''}
                  onChange={(e) => set({ column: e.target.value })}
                  disabled={!datasetId || columns.length === 0}
                  style={{ minWidth: 200 }}
                >
                  <option value="">{columns.length === 0 ? 'no columns — document them in Data' : 'choose a column…'}</option>
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : null}
            </div>

            <div style={{ marginTop: 12 }}>
              <span className="comp-label" style={{ margin: 0 }}>Dimensions (slice by)</span>
              {columns.length === 0 ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  {datasetId ? 'This dataset has no documented columns yet — add column docs in Data.' : 'Pick a host dataset to choose dimensions.'}
                </p>
              ) : (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {columns.filter((c) => c !== form.column).map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`switch${form.dimensions.includes(c) ? ' on' : ''}`}
                      onClick={() => toggleDimension(c)}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{c}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {mode !== 'yaml' ? (
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={submit} disabled={!canSubmit}>
              {busy ? <span className="spin" /> : 'Define metric'}
            </button>
          </div>
        ) : null}

        {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}
      </div>

      {result ? (
        <>
          <div className="section-title">Convergence · form and agent resolve to one measure</div>
          <ChecksList rows={result.convergence.rows} />

          <div className="section-title">Build · apply → verify</div>
          <BuildRowsView build={result.build} />
          <p className="hint" style={{ marginTop: 8 }}>
            Canonical member <code>{result.member}</code> — the single number the explorer,
            dashboards and the agent all resolve.
          </p>

          <div className="section-title">Generated Cube model</div>
          <pre className="codeblock">{result.cube}</pre>
        </>
      ) : null}
    </>
  );
}
