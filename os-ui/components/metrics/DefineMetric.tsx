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

type Form = { name: string; aggregation: Aggregation; column: string; dimensions: string };
type Mode = 'form' | 'agent' | 'yaml';

const EMPTY: Form = { name: '', aggregation: 'sum', column: '', dimensions: '' };

/**
 * Best-effort client parse of a metrics-agent prompt into the SAME form fields, e.g.
 * "define revenue as the sum of net_amount by region" →
 *   { name: revenue, aggregation: sum, column: net_amount, dimensions: region }.
 * It only fills what it recognizes — the user reviews the result before submitting, and
 * the API still proves form == agent on the server (convergence).
 */
function parsePrompt(text: string): Form {
  const t = text.trim();
  const lower = t.toLowerCase();

  let aggregation: Aggregation = 'sum';
  if (/\bcount[\s_]?distinct\b|\bdistinct\b|\bunique\b/.test(lower)) aggregation = 'count_distinct';
  else if (/\bcount\b|\bnumber of\b/.test(lower)) aggregation = 'count';
  else if (/\bavg\b|\baverage\b|\bmean\b/.test(lower)) aggregation = 'avg';
  else if (/\bsum\b|\btotal\b/.test(lower)) aggregation = 'sum';
  else if (/\bmin\b|\bminimum\b/.test(lower)) aggregation = 'min';
  else if (/\bmax\b|\bmaximum\b/.test(lower)) aggregation = 'max';

  // name — the words after "define"/"call it"/"metric" and before "as".
  let name = '';
  const nameMatch = t.match(/(?:define|call it|create|metric)\s+(.+?)\s+(?:as|=|:)\b/i);
  if (nameMatch) name = nameMatch[1].trim();
  else {
    const lead = t.match(/^([A-Za-z][\w ]*?)\s+(?:as|=|:)\b/);
    if (lead) name = lead[1].trim();
  }

  // column — the identifier after "of"/"on"/"column" (the thing being aggregated).
  let column = '';
  if (aggregation !== 'count') {
    const colMatch = t.match(/\b(?:of|on|over|column|field)\s+(?:the\s+)?([A-Za-z_][\w]*)/i);
    if (colMatch) column = colMatch[1];
  }

  // dimensions — everything after "by", split on "and"/commas.
  let dimensions = '';
  const dimMatch = t.match(/\bby\s+(.+)$/i);
  if (dimMatch) {
    dimensions = dimMatch[1]
      .split(/,|\band\b/i)
      .map((s) => s.trim().replace(/[.;]+$/, ''))
      .filter(Boolean)
      .join(', ');
  }

  return { name, aggregation, column, dimensions };
}

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

export default function DefineMetric({ onDefined }: { onDefined: () => void }) {
  const [datasetId, setDatasetId] = useState('');
  const [mode, setMode] = useState<Mode>('form');
  const [form, setForm] = useState<Form>(EMPTY);
  const [prompt, setPrompt] = useState('define revenue as the sum of net_amount by region');
  const [usedAgent, setUsedAgent] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<DefineResult | null>(null);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const applyPrompt = useCallback(() => {
    setForm(parsePrompt(prompt));
    setUsedAgent(true);
  }, [prompt]);

  const submit = useCallback(async () => {
    setErr(''); setBusy(true); setResult(null);
    const payload = {
      name: form.name.trim(),
      aggregation: form.aggregation,
      column: form.column.trim(),
      dimensions: form.dimensions.split(',').map((s) => s.trim()).filter(Boolean),
    };
    try {
      const res = await fetch('/api/metrics/define', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // In agent mode we send the SAME parsed form as `agent` so the API can prove
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
        Define a measure once — by <strong>form</strong>, by <strong>agent</strong>, or in
        <strong> Cube YAML</strong>. All three are doors to one artifact: the API proves they
        converge before it persists, so the definition can never fork.
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
              placeholder="define revenue as the sum of net_amount by region"
            />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn ghost" onClick={applyPrompt} disabled={!prompt.trim()}>Parse →</button>
              <span className="hint" style={{ marginTop: 6 }}>Parsed into the same fields below — review, then define.</span>
            </div>
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
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14 }}>
            <input placeholder="name (e.g. Revenue)" value={form.name} onChange={(e) => set({ name: e.target.value })} style={{ maxWidth: 180 }} />
            <select value={form.aggregation} onChange={(e) => set({ aggregation: e.target.value as Aggregation })}>
              {AGGREGATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            {form.aggregation !== 'count' ? (
              <input placeholder="column (e.g. net_amount)" value={form.column} onChange={(e) => set({ column: e.target.value })} style={{ maxWidth: 180 }} />
            ) : null}
            <input placeholder="dimensions, comma-separated (region, order_date)" value={form.dimensions} onChange={(e) => set({ dimensions: e.target.value })} style={{ maxWidth: 320 }} />
          </div>
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
          <div className="section-title">Convergence · form == agent == yaml</div>
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
