/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type DatasetGroups,
  type DefineResult,
  BuildRowsView,
  ChecksList,
  leaf,
} from './shared';

/**
 * The guided metric editor — a no-code flow a business user can drive end-to-end:
 *
 *   ① source   — pick a governed Gold dataset
 *   ② measure  — choose what to measure (count / distinct / sum / average / min / max
 *                / ratio) and, for a ratio, the two measures to divide
 *   ③ refine   — optional guided filter (only count rows that match), a time window
 *                (running total or trailing N periods), and a display format
 *   ④ slice    — dimensions + an optional time grain to preview by
 *   ⑤ preview  — the LIVE number, run through the SAME governed Cube query the saved
 *                metric resolves (no SQL, per-viewer RLS) — see it before you save
 *   ⑥ save     — persists via /api/metrics/define (form / agent / YAML converge to ONE
 *                measure, proven server-side)
 *
 * "Advanced" folds out the raw Cube measure config + a natural-language agent + the
 * generated YAML for power users — but the default is entirely guided. Everything routes
 * through the one governed define path; this is a friendlier door, never a parallel one.
 */

const AGGREGATIONS: { value: string; label: string; hint: string }[] = [
  { value: 'count', label: 'Count of rows', hint: 'how many records' },
  { value: 'count_distinct', label: 'Count of unique values', hint: 'distinct values in a column' },
  { value: 'count_distinct_approx', label: 'Count of unique (fast, approximate)', hint: 'HyperLogLog — huge datasets' },
  { value: 'sum', label: 'Sum', hint: 'total of a numeric column' },
  { value: 'avg', label: 'Average', hint: 'mean of a numeric column' },
  { value: 'min', label: 'Minimum', hint: 'smallest value' },
  { value: 'max', label: 'Maximum', hint: 'largest value' },
  { value: 'number', label: 'Ratio (a ÷ b)', hint: 'divide one measure by another' },
];

const OPERATORS = [
  { value: 'equals', label: 'is' },
  { value: 'notEquals', label: 'is not' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'at least' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
  { value: 'set', label: 'is set' },
  { value: 'notSet', label: 'is empty' },
] as const;

const WINDOW_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const FORMATS = [
  { value: '', label: 'Plain number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'number', label: 'Formatted number' },
] as const;
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;

type WindowMode = 'none' | 'running' | 'trailing';

type Form = {
  name: string;
  aggregation: string;
  column: string;
  dimensions: string[];
  // rich, guided
  filter: { on: boolean; column: string; operator: string; value: string };
  windowMode: WindowMode;
  windowAmount: number;
  windowUnit: (typeof WINDOW_UNITS)[number];
  ratio: { numerator: string; denominator: string };
  format: string;
  timeDimension: string;
  granularity: (typeof GRAINS)[number];
};

const EMPTY: Form = {
  name: '',
  aggregation: 'sum',
  column: '',
  dimensions: [],
  filter: { on: false, column: '', operator: 'equals', value: '' },
  windowMode: 'none',
  windowAmount: 7,
  windowUnit: 'day',
  ratio: { numerator: '', denominator: '' },
  format: '',
  timeDimension: '',
  granularity: 'month',
};

type Column = { name: string };
type Measure = { name: string; type: string };

type PreviewResult = {
  member: string;
  rows: Record<string, unknown>[];
  mode: 'live' | 'offline-mock';
  /** Cube is up but the just-defined measure hasn't sync'd yet — show "syncing", not an error. */
  pending?: boolean;
};

/** Build the API payload from the guided form (the shape /api/metrics/define reads). */
function toPayload(form: Form) {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    aggregation: form.aggregation,
    column: form.column.trim(),
    dimensions: form.dimensions,
  };
  if (form.filter.on && form.filter.column) {
    payload.filter = { column: form.filter.column, operator: form.filter.operator, value: form.filter.value };
  }
  if (form.windowMode === 'running') payload.runningTotal = true;
  else if (form.windowMode === 'trailing') payload.rollingWindow = { amount: form.windowAmount, unit: form.windowUnit };
  if (form.aggregation === 'number') payload.ratio = { numerator: form.ratio.numerator.trim(), denominator: form.ratio.denominator.trim() };
  if (form.format) payload.format = form.format;
  return payload;
}

function DatasetPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
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
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 260 }}>
      <option value="">choose a dataset…</option>
      {all.map((d) => <option key={d.id} value={d.id}>{d.name} · {tierLabel[d.tier]}</option>)}
    </select>
  );
}

type DatasetState = { columns: string[]; measures: Measure[]; deliverable: boolean };
const EMPTY_DATASET: DatasetState = { columns: [], measures: [], deliverable: true };

/** Fetch the host dataset's real columns + existing measures (for ratio pickers). */
function useDataset(datasetId: string): DatasetState {
  const [state, setState] = useState<DatasetState>(EMPTY_DATASET);
  useEffect(() => {
    if (!datasetId) { setState(EMPTY_DATASET); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}`, { cache: 'no-store' });
        const data = await res.json();
        if (live && res.ok) {
          const ds = data?.dataset ?? {};
          const cols = (ds.columns ?? []) as Column[];
          const ms = (ds.measures ?? []) as Measure[];
          // A metric only reaches Cube if the dataset is governed (not private/'dataset')
          // AND its Gold mart is built (mirrors lib/data/cube-models.ts cubeDeliverable).
          const deliverable = ds.tier !== 'dataset' && Boolean(ds?.versions?.gold?.built);
          setState({ columns: cols.map((c) => c.name).filter(Boolean), measures: ms, deliverable });
        }
      } catch { if (live) setState(EMPTY_DATASET); }
    })();
    return () => { live = false; };
  }, [datasetId]);
  return state;
}

export default function DefineMetric({ onDefined }: { onDefined: () => void }) {
  const [datasetId, setDatasetId] = useState('');
  const [form, setForm] = useState<Form>(EMPTY);
  const [advanced, setAdvanced] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('total net revenue by region');
  const [usedAgent, setUsedAgent] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentErr, setAgentErr] = useState('');

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<DefineResult | null>(null);

  const { columns, measures, deliverable } = useDataset(datasetId);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const isRatio = form.aggregation === 'number';
  const needsColumn = !isRatio && form.aggregation !== 'count';

  const timeColumns = useMemo(
    () => columns.filter((c) => /(_at|_date|_ts|_time|date|timestamp)$/i.test(c) || c.toLowerCase() === 'date'),
    [columns],
  );

  // The Cube VIEW only exposes its `includes` members (measures + non-PK dims):
  // the PRIMARY KEY is a cube dimension but NOT in the view, so slicing on it 400s
  // ("<pk> not found for path <view>.<pk>"). Mirror lib/data/metrics.ts viewMembers
  // client-side: drop the PK (same rule: first `*_id`/`id` column, else first column).
  const sliceMembers = useMemo(() => {
    const pk = columns.find((c) => /(^|_)id$/.test(c.toLowerCase())) ?? columns[0];
    return columns.filter((c) => c !== pk);
  }, [columns]);

  const toggleDimension = (col: string) =>
    setForm((f) => ({
      ...f,
      dimensions: f.dimensions.includes(col) ? f.dimensions.filter((d) => d !== col) : [...f.dimensions, col],
    }));

  const canSubmit =
    !busy && datasetId !== '' && form.name.trim() !== '' &&
    (form.aggregation === 'count'
      ? true
      : isRatio
        ? form.ratio.numerator.trim() !== '' && form.ratio.denominator.trim() !== ''
        : form.column.trim() !== '');

  // The agent proposes a metric grounded in the dataset's real columns via the ONE
  // governed assistant; the fields update, the user reviews, then defines.
  const askAgent = useCallback(async () => {
    if (!datasetId) { setAgentErr('Pick a dataset first.'); return; }
    setAgentErr(''); setAgentBusy(true);
    try {
      const res = await fetch('/api/metrics/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datasetId, goal: agentPrompt }),
      });
      const data = await res.json();
      if (!res.ok) { setAgentErr(data.error ?? 'The agent could not propose a metric'); return; }
      const p = data.form as { name: string; aggregation: string; column: string; dimensions: string[] };
      setForm((f) => ({
        ...f,
        name: p.name ?? '',
        aggregation: AGGREGATIONS.some((a) => a.value === p.aggregation) ? p.aggregation : 'sum',
        column: p.column ?? '',
        dimensions: Array.isArray(p.dimensions) ? p.dimensions : [],
      }));
      setUsedAgent(true);
    } catch (e) { setAgentErr((e as Error).message); } finally { setAgentBusy(false); }
  }, [datasetId, agentPrompt]);

  const runPreview = useCallback(async () => {
    if (!canSubmit) { setPreviewErr('Complete the metric above first.'); setPreview(null); return; }
    setPreviewErr(''); setPreviewBusy(true);
    try {
      const res = await fetch('/api/metrics/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          datasetId,
          form: toPayload(form),
          dimensions: form.dimensions,
          timeDimension: form.timeDimension || undefined,
          granularity: form.timeDimension ? form.granularity : undefined,
          limit: 50,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setPreviewErr(data.error ?? 'Preview failed'); setPreview(null); return; }
      setPreview({ member: data.member, rows: data.rows ?? [], mode: data.mode, pending: data.pending });
    } catch (e) { setPreviewErr((e as Error).message); setPreview(null); } finally { setPreviewBusy(false); }
  }, [canSubmit, datasetId, form]);

  const submit = useCallback(async () => {
    setErr(''); setBusy(true); setResult(null);
    const payload = toPayload(form);
    try {
      const res = await fetch('/api/metrics/define', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datasetId, form: payload, agent: usedAgent ? payload : undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not define the metric'); return; }
      setResult(data);
      onDefined();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [datasetId, form, usedAgent, onDefined]);

  const previewCols = preview && preview.rows.length ? Object.keys(preview.rows[0]) : [];

  return (
    <>
      <p className="lead" style={{ marginTop: 4 }}>
        Build a metric in plain language — pick what to measure, refine it, and see the
        live number before you save. Every metric resolves to one governed definition the
        explorer, dashboards and the assistant all read.
      </p>

      {/* ① Source */}
      <div className="guided-panel">
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="comp-label" style={{ margin: 0 }}>1 · Source dataset</span>
          <DatasetPicker value={datasetId} onChange={setDatasetId} />
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          A metric lives on a governed Gold <strong>asset</strong> or <strong>product</strong>. Pick a
          private dataset and the platform will tell you to promote it in Data first.
        </p>
        {datasetId && !deliverable ? (
          <p className="hint" style={{ marginTop: 6 }}>
            Heads up: promote this dataset to <strong>Shared</strong> and build <strong>Gold</strong> so
            its metrics reach the query engine — you can still define now, but the live value
            won&apos;t resolve until then.
          </p>
        ) : null}
      </div>

      {/* ② Measure */}
      <div className="guided-panel" style={{ marginTop: 14 }}>
        <span className="comp-label" style={{ margin: 0 }}>2 · What do you want to measure?</span>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
          <input
            placeholder="name it (e.g. Revenue)"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            style={{ maxWidth: 200 }}
          />
          <select value={form.aggregation} onChange={(e) => set({ aggregation: e.target.value })} style={{ minWidth: 220 }}>
            {AGGREGATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          {needsColumn ? (
            <select
              value={columns.includes(form.column) ? form.column : ''}
              onChange={(e) => set({ column: e.target.value })}
              disabled={!datasetId || columns.length === 0}
              style={{ minWidth: 200 }}
            >
              <option value="">{columns.length === 0 ? 'no columns — document them in Data' : 'of column…'}</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : null}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          {AGGREGATIONS.find((a) => a.value === form.aggregation)?.hint}
        </p>

        {isRatio ? (
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <span className="hint" style={{ margin: 0 }}>Divide</span>
            <select value={form.ratio.numerator} onChange={(e) => set({ ratio: { ...form.ratio, numerator: e.target.value } })} disabled={measures.length === 0} style={{ minWidth: 160 }}>
              <option value="">numerator…</option>
              {measures.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
            <span className="hint" style={{ margin: 0 }}>by</span>
            <select value={form.ratio.denominator} onChange={(e) => set({ ratio: { ...form.ratio, denominator: e.target.value } })} disabled={measures.length === 0} style={{ minWidth: 160 }}>
              <option value="">denominator…</option>
              {measures.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
            {measures.length === 0 ? <span className="hint" style={{ margin: 0 }}>define the two base measures first</span> : null}
          </div>
        ) : null}
      </div>

      {/* ③ Refine */}
      <div className="guided-panel" style={{ marginTop: 14 }}>
        <span className="comp-label" style={{ margin: 0 }}>3 · Refine (optional)</span>

        {/* Guided filter */}
        <div style={{ marginTop: 10 }}>
          <label className="chk" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={form.filter.on} onChange={(e) => set({ filter: { ...form.filter, on: e.target.checked } })} />
            Only count rows where…
          </label>
          {form.filter.on ? (
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <select value={form.filter.column} onChange={(e) => set({ filter: { ...form.filter, column: e.target.value } })} disabled={columns.length === 0} style={{ minWidth: 160 }}>
                <option value="">column…</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={form.filter.operator} onChange={(e) => set({ filter: { ...form.filter, operator: e.target.value } })}>
                {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {form.filter.operator !== 'set' && form.filter.operator !== 'notSet' ? (
                <input placeholder="value" value={form.filter.value} onChange={(e) => set({ filter: { ...form.filter, value: e.target.value } })} style={{ maxWidth: 160 }} />
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Time window */}
        <div style={{ marginTop: 14 }}>
          <span className="hint" style={{ margin: 0 }}>Time window</span>
          <div className="seg" style={{ marginTop: 6 }}>
            <button className={form.windowMode === 'none' ? 'on' : ''} onClick={() => set({ windowMode: 'none' })}>None</button>
            <button className={form.windowMode === 'running' ? 'on' : ''} onClick={() => set({ windowMode: 'running' })}>Running total</button>
            <button className={form.windowMode === 'trailing' ? 'on' : ''} onClick={() => set({ windowMode: 'trailing' })}>Trailing window</button>
          </div>
          {form.windowMode === 'trailing' ? (
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <span className="hint" style={{ margin: 0 }}>last</span>
              <input type="number" min={1} value={form.windowAmount} onChange={(e) => set({ windowAmount: Math.max(1, Number(e.target.value) || 1) })} style={{ maxWidth: 80 }} />
              <select value={form.windowUnit} onChange={(e) => set({ windowUnit: e.target.value as Form['windowUnit'] })}>
                {WINDOW_UNITS.map((u) => <option key={u} value={u}>{u}s</option>)}
              </select>
            </div>
          ) : form.windowMode === 'running' ? (
            <p className="hint" style={{ marginTop: 6 }}>Cumulative from the beginning of time.</p>
          ) : null}
        </div>

        {/* Format */}
        <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 14 }}>
          <span className="hint" style={{ margin: 0 }}>Display as</span>
          <select value={form.format} onChange={(e) => set({ format: e.target.value })}>
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
      </div>

      {/* ④ Slice */}
      <div className="guided-panel" style={{ marginTop: 14 }}>
        <span className="comp-label" style={{ margin: 0 }}>4 · Slice by (optional)</span>
        {columns.length === 0 ? (
          <p className="hint" style={{ marginTop: 6 }}>
            {datasetId ? 'This dataset has no documented columns yet — add column docs in Data.' : 'Pick a source dataset to choose dimensions.'}
          </p>
        ) : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {sliceMembers.filter((c) => c !== form.column).map((c) => (
              <button key={c} type="button" className={`switch${form.dimensions.includes(c) ? ' on' : ''}`} onClick={() => toggleDimension(c)}>
                <span className="switch-track"><span className="switch-thumb" /></span>
                <span className="switch-text">{c}</span>
              </button>
            ))}
          </div>
        )}
        {timeColumns.length > 0 ? (
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <span className="hint" style={{ margin: 0 }}>Over time</span>
            <select value={form.timeDimension} onChange={(e) => set({ timeDimension: e.target.value })} style={{ minWidth: 160 }}>
              <option value="">not by time</option>
              {timeColumns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {form.timeDimension ? (
              <select value={form.granularity} onChange={(e) => set({ granularity: e.target.value as Form['granularity'] })}>
                {GRAINS.map((g) => <option key={g} value={g}>by {g}</option>)}
              </select>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ⑤ Preview */}
      <div className="guided-panel" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="comp-label" style={{ margin: 0 }}>5 · Preview the number</span>
          <button className="btn ghost" onClick={runPreview} disabled={previewBusy || !canSubmit}>
            {previewBusy ? <span className="spin" /> : 'Preview →'}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Runs the exact governed query your saved metric will resolve — under your own
          identity, so row-level security applies. Nothing is saved yet.
        </p>
        {previewErr ? <div className="error" style={{ marginTop: 10 }}>{previewErr}</div> : null}
        {preview ? (
          preview.pending ? (
            <div className="stub-page" style={{ marginTop: 10 }}>
              Syncing — the live value appears within a few seconds as the query engine picks
              up this metric. Preview again shortly.
            </div>
          ) : preview.rows.length === 0 ? (
            <div className="stub-page" style={{ marginTop: 10 }}>No rows for you under the current filter.</div>
          ) : (
            <>
              <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 10 }}>
                <span className={`badge ${preview.mode === 'live' ? 'ok' : 'muted'}`}>{preview.mode}</span>
                <span className="muted mono" style={{ fontSize: 12 }}>{preview.member}</span>
              </div>
              <div className="table-wrap" style={{ marginTop: 10 }}>
                <table>
                  <thead><tr>{previewCols.map((c) => <th key={c}>{leaf(c)}</th>)}</tr></thead>
                  <tbody>
                    {preview.rows.slice(0, 20).map((r, i) => (
                      <tr key={i}>{previewCols.map((c) => <td key={c}>{String(r[c] ?? '')}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        ) : null}
      </div>

      {/* Advanced — agent / raw config / YAML */}
      <button className={`btn ghost sm${advanced ? ' on' : ''}`} style={{ marginTop: 14 }} onClick={() => setAdvanced((v) => !v)}>
        {advanced ? '▾ Advanced' : '▸ Advanced (agent · raw config · YAML)'}
      </button>
      {advanced ? (
        <div className="guided-panel" style={{ marginTop: 10 }}>
          <span className="comp-label" style={{ margin: 0 }}>Describe it in words</span>
          <textarea
            rows={2}
            value={agentPrompt}
            onChange={(e) => setAgentPrompt(e.target.value)}
            placeholder="e.g. total net revenue by region"
            style={{ marginTop: 8 }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn ghost" onClick={askAgent} disabled={agentBusy || !agentPrompt.trim() || !datasetId}>
              {agentBusy ? <span className="spin" /> : 'Propose into the form →'}
            </button>
            <span className="hint" style={{ marginTop: 6 }}>
              The governed assistant fills the guided fields above using this dataset&apos;s real columns — review, then save.
            </span>
          </div>
          {agentErr ? <div className="error" style={{ marginTop: 10 }}>{agentErr}</div> : null}

          <div className="section-title" style={{ marginTop: 16 }}>Cube measure config</div>
          <pre className="codeblock">{JSON.stringify(toPayload(form), null, 2)}</pre>

          {result?.cube ? (
            <>
              <div className="section-title">Generated Cube YAML</div>
              <pre className="codeblock">{result.cube}</pre>
            </>
          ) : (
            <p className="hint">The generated Cube YAML appears here after you save.</p>
          )}
        </div>
      ) : null}

      {/* Save */}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={submit} disabled={!canSubmit}>
          {busy ? <span className="spin" /> : 'Save metric'}
        </button>
      </div>
      {err ? <div className="error" style={{ marginTop: 14 }}>{err}</div> : null}

      {result ? (
        <>
          {result.pending ? (
            <div className="stub-page" style={{ marginTop: 14 }}>
              ✓ Metric saved — its live value appears within a few seconds as the query engine
              syncs. Nothing to fix; refresh the metric shortly to see the number.
            </div>
          ) : null}
          <div className="section-title">Convergence · form and agent resolve to one measure</div>
          <ChecksList rows={result.convergence.rows} />

          <div className="section-title">Build · apply → verify</div>
          <BuildRowsView build={result.build} />
          <p className="hint" style={{ marginTop: 8 }}>
            Canonical member <code>{result.member}</code> — the single number the explorer,
            dashboards and the assistant all resolve.
          </p>

          <div className="section-title">Generated Cube model</div>
          <pre className="codeblock">{result.cube}</pre>
        </>
      ) : null}
    </>
  );
}
