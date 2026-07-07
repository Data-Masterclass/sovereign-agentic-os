/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  compileGoldJoin,
  personalSchema,
  slug,
  JOIN_TYPES,
  MEASURE_AGGS,
  MEASURE_OPS,
  type JoinType,
  type MeasureAgg,
  type MeasureOp,
  type GoldDimension,
  type GoldMeasure,
  type JoinInput,
} from '@/lib/data/transform';

/**
 * Gold JOIN builder — dataset REUSE (data-tab stage 4). Pick 1..n OTHER datasets you
 * can see, choose the join keys, project the columns and name the business measures →
 * one governed CTAS writes `gold_<slug>` in YOUR schema, reading each joined table AS
 * YOU (so masking holds). Calm + guided: the machinery (aliases, GROUP BY, the exact
 * SQL) stays hidden behind "Show the code" until you ask for it; the Gold step lights
 * only after the table is written into Trino and a probe reads it back.
 */

type Joinable = { id: string; name: string; domain: string; tier: string; fqn: string; columns: string[] };
type BuildRow = { tool: string; status: 'ok' | 'fail'; detail: string; error?: string };
type BuildReport = { ok: boolean; rows: BuildRow[]; mode?: 'live' | 'offline-mock' };

type JoinRow = { datasetId: string; type: JoinType; baseCol: string; joinCol: string };
type DimRow = { source: string; as: string }; // source = "ref::column"
type MeasureRow = { name: string; agg: MeasureAgg; col: string; op: '' | MeasureOp; col2: string };

const NONE = '';

/** Decode a "ref::column" select value into a ColRef, or null when unset. */
function colRef(v: string): { ref: number; column: string } | null {
  if (!v) return null;
  const i = v.indexOf('::');
  if (i < 0) return null;
  const ref = Number(v.slice(0, i));
  const column = v.slice(i + 2);
  if (!Number.isInteger(ref) || !column) return null;
  return { ref, column };
}

export default function GoldJoinPanel({
  datasetId,
  datasetName,
  owner,
  domain,
  tier,
  columns,
  onCommitted,
}: {
  datasetId: string;
  datasetName: string;
  owner: string;
  domain: string;
  tier: string;
  columns: string[];
  onCommitted: (stages: unknown[]) => void;
}) {
  const [joinable, setJoinable] = useState<Joinable[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [joins, setJoins] = useState<JoinRow[]>([]);
  const [dims, setDims] = useState<DimRow[]>([]);
  const [measures, setMeasures] = useState<MeasureRow[]>([]);
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<BuildReport | null>(null);
  const [busy, setBusy] = useState<'' | 'build' | 'pass'>('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}/joinable`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) { setLoadErr(data.error ?? 'Could not load datasets to join'); return; }
        setJoinable(data.datasets ?? []);
      } catch (e) { setLoadErr((e as Error).message); }
    })();
  }, [datasetId]);

  const baseCols = useMemo(() => Array.from(new Set(columns.filter(Boolean))), [columns]);
  const byId = useMemo(() => new Map(joinable.map((j) => [j.id, j])), [joinable]);

  // Only fully-specified joins take part — their ORDER fixes the table refs (base = 0,
  // the i-th active join = ref i+1), matching exactly how the server compiles the CTAS.
  const activeJoins = useMemo(
    () => joins.filter((j) => j.datasetId && j.baseCol && j.joinCol && byId.has(j.datasetId)),
    [joins, byId],
  );

  /** Column sources for the dimension/measure pickers, refs aligned with activeJoins. */
  const sources = useMemo(() => {
    const out: { ref: number; label: string; columns: string[] }[] = [
      { ref: 0, label: `${datasetName} (this dataset)`, columns: baseCols },
    ];
    activeJoins.forEach((j, i) => {
      const d = byId.get(j.datasetId);
      out.push({ ref: i + 1, label: d?.name ?? j.datasetId, columns: d?.columns ?? [] });
    });
    return out;
  }, [datasetName, baseCols, activeJoins, byId]);

  const target = useMemo(() => {
    const schema = tier === 'dataset' ? personalSchema(owner) : domain;
    return `iceberg.${schema}.gold_${slug(datasetName)}`;
  }, [tier, owner, domain, datasetName]);

  // Assemble the compiler inputs from the guided state (client preview == server plan).
  const spec = useMemo(() => {
    const schema = tier === 'dataset' ? personalSchema(owner) : domain;
    const s = slug(datasetName);
    const source = `iceberg.${schema}.silver_${s}`;
    const jin: JoinInput[] = activeJoins.map((j) => ({
      table: byId.get(j.datasetId)!.fqn,
      type: j.type,
      on: [{ left: { ref: 0, column: j.baseCol }, right: j.joinCol }],
    }));
    const dimensions: GoldDimension[] = dims
      .map((d) => {
        const c = colRef(d.source);
        return c ? { col: c, ...(d.as.trim() ? { as: d.as.trim() } : {}) } : null;
      })
      .filter((x): x is GoldDimension => x !== null);
    const gmeasures: GoldMeasure[] = measures
      .map((m): GoldMeasure | null => {
        const name = m.name.trim();
        if (!name) return null;
        const c = colRef(m.col);
        if (m.agg === 'count' && !c) return { name, agg: 'count' };
        if (!c) return null;
        if (m.op && m.col2) {
          const right = colRef(m.col2);
          if (!right) return null;
          return { name, agg: m.agg, left: c, op: m.op, right };
        }
        return { name, agg: m.agg, col: c };
      })
      .filter((x): x is GoldMeasure => x !== null);
    return { source, target, joins: jin, dimensions, measures: gmeasures };
  }, [tier, owner, domain, datasetName, activeJoins, byId, dims, measures, target]);

  const compiled = useMemo(() => {
    if (spec.joins.length === 0) return { sql: '', error: 'Add a dataset to join.' };
    try {
      return { sql: compileGoldJoin(spec), error: '' };
    } catch (e) {
      return { sql: '', error: (e as Error).message };
    }
  }, [spec]);

  function addJoin() {
    setJoins((j) => [...j, { datasetId: '', type: 'inner', baseCol: '', joinCol: '' }]);
  }
  function patchJoin(i: number, patch: Partial<JoinRow>) {
    setJoins((js) => js.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  }

  async function build() {
    setErr(''); setReport(null); setBusy('build');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/gold-join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // spec.joins is built in activeJoins order, so refs stay aligned server-side.
          picks: spec.joins.map((j, i) => ({ datasetId: activeJoins[i].datasetId, type: j.type, on: j.on })),
          dimensions: spec.dimensions,
          measures: spec.measures,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not build the Gold join'); return; }
      if (data.build && !data.build.ok) { setReport(data.build); setErr(data.error ?? 'The join did not pass'); return; }
      onCommitted(data.stages ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function passThrough() {
    setErr(''); setBusy('pass');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/version`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layer: 'gold', passThrough: true }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not pass through'); return; }
      onCommitted(data.stages ?? []);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  const SourceOptions = () => (
    <>
      {sources.map((s) => (
        <optgroup key={s.ref} label={s.label}>
          {s.columns.map((c) => <option key={`${s.ref}::${c}`} value={`${s.ref}::${c}`}>{c}</option>)}
        </optgroup>
      ))}
    </>
  );

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        Make it business-ready by <strong>reusing</strong> data you already trust. Join{' '}
        <code className="mono">silver_{slug(datasetName)}</code> to other datasets you can see, pick the
        columns you want and name your measures. It writes one governed Gold table
        (<code className="mono">gold_{slug(datasetName)}</code>) that only ever reads what you’re allowed to see.
      </p>

      {loadErr ? <div className="error">{loadErr}</div> : null}

      {/* Join to … */}
      <div className="section-title" style={{ marginTop: 8 }}>Join to</div>
      {joinable.length === 0 && !loadErr ? (
        <div className="hint" style={{ marginTop: 0 }}>
          No shared datasets you can reuse yet. Ask a colleague to share (promote) one, or promote your own.
        </div>
      ) : null}
      {joins.map((j, i) => {
        const picked = byId.get(j.datasetId);
        return (
          <div className="row" key={i} style={{ gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={j.datasetId} onChange={(e) => patchJoin(i, { datasetId: e.target.value, joinCol: '' })}>
              <option value="">dataset…</option>
              {joinable.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.domain}</option>)}
            </select>
            <select value={j.type} onChange={(e) => patchJoin(i, { type: e.target.value as JoinType })}>
              {JOIN_TYPES.map((t) => <option key={t} value={t}>{t === 'inner' ? 'inner join' : 'left join'}</option>)}
            </select>
            <span className="muted">on</span>
            <select value={j.baseCol} onChange={(e) => patchJoin(i, { baseCol: e.target.value })}>
              <option value="">this column…</option>
              {baseCols.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="muted">=</span>
            <select value={j.joinCol} disabled={!picked} onChange={(e) => patchJoin(i, { joinCol: e.target.value })}>
              <option value="">their column…</option>
              {(picked?.columns ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn ghost sm" onClick={() => setJoins((js) => js.filter((_, k) => k !== i))}>Remove</button>
          </div>
        );
      })}
      <button className="btn ghost sm" onClick={addJoin} disabled={joinable.length === 0}>+ Add a dataset</button>

      {/* Keep columns */}
      <div className="section-title" style={{ marginTop: 16 }}>Keep columns</div>
      {dims.map((d, i) => (
        <div className="row" key={i} style={{ gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <select value={d.source} onChange={(e) => setDims((ds) => ds.map((x, k) => (k === i ? { ...x, source: e.target.value } : x)))}>
            <option value="">column…</option>
            <SourceOptions />
          </select>
          <span className="muted">as</span>
          <input value={d.as} placeholder="(same name)" style={{ maxWidth: 160 }}
            onChange={(e) => setDims((ds) => ds.map((x, k) => (k === i ? { ...x, as: e.target.value } : x)))} />
          <button className="btn ghost sm" onClick={() => setDims((ds) => ds.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn ghost sm" onClick={() => setDims((ds) => [...ds, { source: NONE, as: '' }])}>+ Add a column</button>

      {/* Measures */}
      <div className="section-title" style={{ marginTop: 16 }}>Measures</div>
      <p className="hint" style={{ marginTop: 0 }}>Derived business numbers — a total, an average, a count, or a formula across the joined columns.</p>
      {measures.map((m, i) => (
        <div className="row" key={i} style={{ gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={m.name} placeholder="measure name" style={{ maxWidth: 170 }}
            onChange={(e) => setMeasures((ms) => ms.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <span className="muted">=</span>
          <select value={m.agg} onChange={(e) => setMeasures((ms) => ms.map((x, k) => (k === i ? { ...x, agg: e.target.value as MeasureAgg } : x)))}>
            {MEASURE_AGGS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <span className="muted">of</span>
          <select value={m.col} onChange={(e) => setMeasures((ms) => ms.map((x, k) => (k === i ? { ...x, col: e.target.value } : x)))}>
            <option value="">{m.agg === 'count' ? 'all rows (count *)' : 'column…'}</option>
            <SourceOptions />
          </select>
          <select value={m.op} onChange={(e) => setMeasures((ms) => ms.map((x, k) => (k === i ? { ...x, op: e.target.value as '' | MeasureOp } : x)))}>
            <option value="">—</option>
            {MEASURE_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {m.op ? (
            <select value={m.col2} onChange={(e) => setMeasures((ms) => ms.map((x, k) => (k === i ? { ...x, col2: e.target.value } : x)))}>
              <option value="">column…</option>
              <SourceOptions />
            </select>
          ) : null}
          <button className="btn ghost sm" onClick={() => setMeasures((ms) => ms.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn ghost sm" onClick={() => setMeasures((ms) => [...ms, { name: '', agg: 'sum', col: NONE, op: '', col2: NONE }])}>+ Add a measure</button>

      {/* Show the code — the exact governed CTAS this runs. */}
      <div style={{ marginTop: 14 }}>
        <button className={`btn ghost sm${showCode ? ' on' : ''}`} onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Hide the code' : '‹ › Show the code'}
        </button>
        {showCode ? (
          compiled.error ? (
            <div className="error" style={{ marginTop: 10 }}>{compiled.error}</div>
          ) : (
            <textarea className="mono" rows={8} value={compiled.sql} readOnly spellCheck={false} style={{ marginTop: 10 }} />
          )
        ) : null}
      </div>

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}
      {report ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Step</th><th>Result</th><th>Detail</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.tool}>
                  <td className="mono">{r.tool}</td>
                  <td className={r.status === 'ok' ? 'ok-note' : 'error'}>{r.status === 'ok' ? '✓' : '✗'}</td>
                  <td>{r.error ?? r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        {report?.mode === 'offline-mock' ? <span className="hint" style={{ margin: 0 }}>offline preview — no live table written</span> : null}
        <button className="btn" onClick={build} disabled={busy !== '' || !!compiled.error}>
          {busy === 'build' ? <span className="spin" /> : 'Build Gold version'}
        </button>
      </div>
      <p className="hint" style={{ textAlign: 'right' }}>
        The Gold step lights only after this joined table is written into Trino and a probe reads it back — no faked check.
      </p>

      <div className="passthrough-note">
        <strong>Already business-ready?</strong>{' '}
        Pass through — your <em>Silver</em> version carries forward as Gold unchanged.
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={passThrough} disabled={busy !== ''}>
            {busy === 'pass' ? <span className="spin" /> : 'Pass through Gold…'}
          </button>
        </div>
      </div>
    </div>
  );
}
